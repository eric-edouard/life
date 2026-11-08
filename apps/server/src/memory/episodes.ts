import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonl } from "../core/files";
import { digest } from "../core/hash";
import { stamp } from "../models/llm";
import { Episode, LocalTime } from "../records/episode";
import type { MadeBy } from "../records/fields";
import { type Correction, InferredPerson } from "../records/observation";
import type { MemoryLabel, Unit, Verdict } from "../records/unit";
import {
  KEEP_AT,
  MemoryType,
  RecordingKind,
  SEARCHABLE_AT,
} from "../records/unit";
import { isActivity } from "../sources/contract";
import { lifelogMissing } from "../sources/lifelog";
import { contextPeopleBy, levelsWith, personallyClose } from "./closeness";
import {
  appendVerdicts,
  daysOf,
  EPISODES,
  episodesNow,
  hiding,
  INFERRED,
  isRereadSince,
  readEpisodes,
  readLabels,
  readUnits,
  readUnitsOf,
  readVerdicts,
  rereadAt,
  runAt,
  type Verdicts,
  verdictOf,
} from "./ledger";
import { linkOf } from "./observe";
import { answeredBy, checkPeople, unknownIn } from "./people";
import { staysOf, where } from "./places";
import { OWNER, type Truth } from "./read-truth";
import { begin, checkedEntries, involvedOf, refContext } from "./run";
import { kindOf } from "./sources";
import {
  areaLookup,
  areaOf,
  type Built,
  daysBefore,
  type Evidence,
  head,
  isFrozen,
  localTime,
  normalizeTopics,
  type Resolve,
  UNKNOWN,
  writeUnits,
} from "./units";
import { episodeNow, namedIn, nearNames, readPeople, unitNow } from "./who";
import { voiceText } from "./words";

// `bun life memory episodes`: what happened in the owner's life, day by day. For each day of the window with a unit not yet
// judged on its current content, the deep-tier model reads the day (`EPISODES_PROMPT`): those units in full, the ones
// judged already as stubs, where his phone stayed, the day's episodes as they stand and those of the day before that may
// continue into it. It returns a verdict per new unit (memory/verdicts.jsonl: what it is, its area, topics,
// importance), the episodes new or changed and those gone (memory/episodes/<day>.jsonl) and who the day's unknown handles
// and names are (memory/people-inferred.jsonl).
// Extraction then reads an episode's units together (extract.ts). Units are written here too (units.ts builds them).

export const EPISODES_PROMPT = "memory-episodes.v7";
// ponytail: a whole day goes in one call (about 200 KB on a busy day, each unit clipped by `head`); split the day
// into halves with the episodes of the first as `earlier` if a day ever outgrows the model's context.
const TOPICS_SHOWN = 40;
/** An episode of an earlier day is shown to the next days until the day after it ends. */
const CARRY_DAYS = 1;

/** The most frequent topics of these verdicts: the vocabulary the next calls are asked to reuse. */
export function topTopics(verdicts: Iterable<Verdict>, n = TOPICS_SHOWN) {
  const counts = new Map<string, number>();
  for (const v of verdicts) {
    for (const t of v.topics) {
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  return [...counts]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, n)
    .map(([t]) => t);
}

/** The areas of the projects a chat belongs to (`Project.chats`), by network chat id and by WhatsApp id. */
export function chatAreas(truth: Truth) {
  const out = new Map<string, string[]>();
  for (const c of truth.chats) {
    const areas = truth.projects
      .filter((p) => p.chats.includes(c.id))
      .map((p) => p.area);
    for (const key of [c.id, c.whatsapp]) {
      if (key && areas.length > 0) {
        out.set(key, [...new Set(areas)]);
      }
    }
  }
  return out;
}

/** Whether an episode line is state for this prompt: made by it, or hidden by him (his correction holds whatever made it). */
const isState = (m: Episode, corrections: Correction[]) =>
  m.madeBy.prompt === EPISODES_PROMPT || hiding(corrections, m.id).length > 0;

/**
 * What a reading of `day` is shown as `earlier`: its own episodes as they stand, those of the days before that may
 * continue into it, ending no earlier than the day before, and its own episodes the owner hid, each with his correction
 * (`hidden`: what he said, in his words), so it is not made again. An episode by an older prompt is not state: under a
 * new prompt the day is read as if for the first time.
 */
export function earlierFor(
  day: string,
  lines: Episode[],
  corrections: Correction[]
): (Episode & { hidden?: { kind: string; note?: string } })[] {
  const since = daysBefore(day, CARRY_DAYS);
  const shown = episodesNow(
    lines.filter((m) => m.day <= day && isState(m, corrections)),
    corrections
  ).filter((m) => m.day === day || daysOf(m)[1] >= since);
  return [...shown, ...hiddenOn(day, lines, corrections)];
}

/** `day`'s episodes the owner hid (`hiding`), each with his latest correction of it. */
const hiddenOn = (day: string, lines: Episode[], corrections: Correction[]) =>
  lines.flatMap((m) => {
    const c = m.day === day ? hiding(corrections, m.id).at(-1) : undefined;
    return c ? [{ ...m, hidden: { kind: c.kind, note: c.note } }] : [];
  });

/**
 * What a reading of `day` leaves in its file: the day's lines that are state, but those `gone`, then the reading's
 * episodes, one line per episode (`episodesNow`'s merge: the last line wins, units and copies joined), each kept to the
 * day's units still there (`units`, ids) and dropped with none; a `within` naming no episode here or in `earlier` is null.
 */
export function dayFileOf(
  day: string,
  reading: { gone: string[]; episodes: Episode[] },
  ctx: {
    corrections: Correction[];
    earlier: Set<string>;
    lines: Episode[];
    units: Set<string>;
  }
) {
  const kept = ctx.lines.filter(
    (m) =>
      m.day === day &&
      isState(m, ctx.corrections) &&
      !reading.gone.includes(m.id)
  );
  const merged = episodesNow([...kept, ...reading.episodes], []).flatMap(
    (m) => {
      const units = m.units.filter((u) => ctx.units.has(u));
      return units.length > 0
        ? [{ ...m, copies: m.copies.filter((u) => units.includes(u)), units }]
        : [];
    }
  );
  const ids = new Set(merged.map((m) => m.id)).union(ctx.earlier);
  return merged.map((m) =>
    m.within && !ids.has(m.within) ? { ...m, within: null } : m
  );
}

const Reply = z.object({
  episodes: z.array(z.unknown()).default([]),
  gone: z.array(z.unknown()).default([]),
  verdicts: z.array(z.unknown()).default([]),
  who: z.array(z.unknown()).default([]),
});
const Judged = z.object({
  area: z.string().nullable().default(null),
  id: z.string(),
  importance: z.int().min(0).max(3),
  // Chats and mail have no kind; the model sometimes says so with null.
  kind: RecordingKind.nullish().transform((k) => k ?? undefined),
  reason: z.string().min(1).max(300),
  topics: z.array(z.string()).nullish(),
  // A label only (importance decides what is read): a type the model made up, like a recording kind, reads as nothing.
  type: MemoryType.catch("nothing"),
  when: z.iso.date().nullable().default(null),
});
const Said = Episode.pick({
  importance: true,
  people: true,
  title: true,
  what: true,
}).extend({
  copies: z.array(z.string()).default([]),
  end: z.string().nullable().default(null),
  id: z.string(),
  place: z.string().nullable().default(null),
  start: z.string().nullable().default(null),
  units: z.array(z.string()),
  within: z.string().nullable().default(null),
});
const at = (s: string | null) => (LocalTime.safeParse(s).success ? s : null);

/** An episode's id, minted from what it is: its day, its start and units (its title too when two episodes share those). */
export const episodeId = (key: string[]) =>
  `ep_${digest("sha1", key.join("|"), 12)}`;

/**
 * Code's last word on a verdict's importance: activity 1 at most (never extracted); a unit he marked (he asked Life to
 * keep it, which says nothing of its weight) and an agent's report (for what it may close) at least KEEP_AT: always read.
 */
export function importanceOf(u: Unit, importance: number) {
  const kind = kindOf(u.source);
  if (isActivity(kind)) {
    return Math.min(importance, SEARCHABLE_AT);
  }
  return u.marked || kind === "agent"
    ? Math.max(importance, KEEP_AT)
    : importance;
}

/** The verdicts of a day's reply for units of that day, once each, their importance `importanceOf`. */
function verdictsOf(
  list: unknown[],
  ctx: { areas: Map<string, string>; madeBy: MadeBy; units: Map<string, Unit> }
) {
  const { entries } = checkedEntries(
    list,
    Judged,
    (e) => e.id,
    (id) => ctx.units.has(id)
  );
  return new Map(
    entries.map(
      ({ area, id, importance, topics, ...rest }): [string, Verdict] => {
        const u = ctx.units.get(id) as Unit;
        return [
          id,
          {
            ...rest,
            area: areaOf(area, ctx.areas),
            hash: u.hash,
            importance: importanceOf(u, importance),
            madeBy: ctx.madeBy,
            schemaVersion: 1,
            topics: normalizeTopics(topics),
            unit: id,
          },
        ];
      }
    )
  );
}

/** A person the model named, as a ref: one it was given, or an `unknown:` name resolved by code; never the owner. */
function personOf(ref: string, ctx: { people: Set<string>; resolve: Resolve }) {
  const link = linkOf(ref, ctx.people, ctx.resolve);
  if ("ref" in link) {
    return link.ref === OWNER ? null : link.ref;
  }
  return "surface" in link ? `${UNKNOWN}${link.surface}` : null;
}

/** Whether these units can make an episode: not when all are what his devices log or his agents did (`isActivity`, agent). */
const isLived = (units: Unit[]) =>
  units.some((u) => {
    const kind = kindOf(u.source);
    return !isActivity(kind) && kind !== "agent";
  });

/**
 * The model's reply for one day, checked: a verdict for a unit of the day (its content hash in `units`), its area one
 * of `areas` (by id or name) or null, commits at importance 1 at most (never extracted); an episode of the day's units
 * (`isLived`), people resolved through the map (the owner left out), an earlier episode's id kept, a new one minted from
 * the day and its units, `within` mapped from the reply's own ids (`new-1`) to the minted ones; `gone`, episodes of
 * `earlier` he did not hide (`dayFileOf` drops only this day's). Anything else is dropped; `invalid` counts the verdicts dropped.
 */
export function parseDay(
  reply: unknown,
  ctx: {
    areas: Map<string, string>;
    day: string;
    earlier: Set<string>;
    /** The ids of this day's episodes he hid (`earlierFor`). */
    hidden: Set<string>;
    madeBy: MadeBy;
    /** The person refs the model was given. */
    people: Set<string>;
    resolve: Resolve;
    units: Map<string, Unit>;
  }
) {
  const said = Reply.parse(reply);
  const verdicts = verdictsOf(said.verdicts, ctx);
  const found = new Map<string, Episode>();
  // The reply's own id of each new episode, to the minted one.
  const minted = new Map<string, string>();
  for (const raw of said.episodes) {
    const r = Said.safeParse(raw);
    const units = r.success ? r.data.units.filter((u) => ctx.units.has(u)) : [];
    if (!(r.success && isLived(units.map((u) => ctx.units.get(u) as Unit)))) {
      continue;
    }
    const m = r.data;
    const people = m.people.flatMap(({ ref, role }) => {
      const p = personOf(ref, ctx);
      return p ? [{ ref: p, role }] : [];
    });
    const key = [ctx.day, m.start ?? "", ...units.toSorted()];
    const isReused = ctx.earlier.has(m.id);
    // Taken: by an episode of this reply, or, unless the model reused it, by one he hid (read again, it stands on the same units).
    const isTaken = (x: string) =>
      found.has(x) || (!isReused && ctx.hidden.has(x));
    let id = isReused ? m.id : episodeId(key);
    for (let salt = [m.title]; isTaken(id); salt = [...salt, "again"]) {
      id = episodeId([...key, ...salt]);
    }
    if (!isReused) {
      minted.set(m.id, id);
    }
    found.set(id, {
      copies: m.copies.filter((u) => units.includes(u)),
      day: ctx.day,
      end: at(m.end),
      id,
      importance: m.importance,
      madeBy: ctx.madeBy,
      people,
      place: m.place || null,
      schemaVersion: 1,
      start: at(m.start),
      title: m.title,
      units,
      what: m.what,
      within: m.within,
    });
  }
  const within = (w: string | null) => {
    const id = (w && minted.get(w)) ?? w;
    return id && (found.has(id) || ctx.earlier.has(id)) ? id : null;
  };
  return {
    episodes: [...found.values()].map((m) => {
      const w = within(m.within);
      return { ...m, within: w === m.id ? null : w };
    }),
    gone: said.gone.filter(
      (id): id is string =>
        typeof id === "string" && ctx.earlier.has(id) && !ctx.hidden.has(id)
    ),
    invalid: said.verdicts.length - verdicts.size,
    verdicts: [...verdicts.values()],
    who: said.who,
  };
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

/**
 * How the verdicts compare with the owner's labels (memory/labels.jsonl): a unit is "kept" at importance KEEP_AT or more,
 * a code-rule drop is a skip, and a label whose unit is gone is only counted in `missing`.
 */
export function agreement(
  labels: MemoryLabel[],
  units: Map<string, Unit>,
  verdicts: Verdicts
) {
  const pairs = labels.flatMap((l) => {
    const u = units.get(l.unitId);
    const v = u && verdictOf(verdicts, u);
    return u && (v || u.drop)
      ? [{ kept: !!v && v.importance >= KEEP_AT, matters: l.matters }]
      : [];
  });
  const count = (kept: boolean, matters: boolean) =>
    pairs.filter((p) => p.kept === kept && p.matters === matters).length;
  const [tp, fp, fn, tn] = [
    count(true, true),
    count(true, false),
    count(false, true),
    count(false, false),
  ];
  return {
    agreement: ratio(tp + tn, pairs.length),
    labeled: pairs.length,
    missing: labels.length - pairs.length,
    precision: ratio(tp, tp + fp),
    recall: ratio(tp, tp + fn),
  };
}

/** Whether a unit has a verdict on its current content by this prompt, not older than his `reread` of it: the cache. */
const judged = (u: Unit, verdicts: Verdicts, rereads: Map<string, string>) => {
  const v = verdictOf(verdicts, u);
  return (
    v?.madeBy.prompt === EPISODES_PROMPT &&
    !isRereadSince(rereads, u.id, runAt(v.madeBy.run))
  );
};

/** Whether a day must be read: one of its units has no verdict on its current content by this prompt, or was reread since. */
export const unread = (
  units: Built[],
  verdicts: Verdicts,
  rereads = new Map<string, string>()
) => units.some((b) => !judged(b.unit, verdicts, rereads));

/** The verdicts of a reading of the day worth keeping: for the units not judged yet on their content, or reread since (the cache). */
export const fresh = (
  said: Verdict[],
  units: Built[],
  verdicts: Verdicts,
  rereads = new Map<string, string>()
) => {
  const byId = new Map(units.map((b) => [b.unit.id, b.unit]));
  return said.filter((v) => {
    const u = byId.get(v.unit);
    return u !== undefined && !judged(u, verdicts, rereads);
  });
};

async function writeDay(day: string, list: Episode[]) {
  await mkdir(EPISODES, { recursive: true });
  await Bun.write(
    join(EPISODES, `${day}.jsonl`),
    list.map((m) => `${JSON.stringify(Episode.parse(m))}\n`).join("")
  );
}

/** Reads the days of `evidence`'s units (its window, `gather`), oldest first, each one not read yet. */
export async function episodes(evidence: Evidence) {
  const step = await begin("episodes", "deep", {
    prompt: EPISODES_PROMPT,
    ...evidence.window,
  });
  const { built: all, failed, read: sources, repos, skipped, truth } = evidence;
  // A source that could not be read counts as a failure: the night must not commit a partial day.
  step.stats.failed += failed.length;
  const days = [...new Set(all.map((b) => b.unit.date))].sort();
  // Units first (code output, rebuildable but for lifelog's chapter units, the only copy of the voice history before
  // conversation-days: kept even when lifelog isn't read); not when a source failed: the files would lose that source's units.
  if (failed.length === 0) {
    await writeUnits(
      days,
      all.map((b) => b.unit),
      (u) => skipped.includes(u.source) || isFrozen(u)
    );
  }
  let verdicts = readVerdicts();
  const { canon, corrections, inferred, refOf, resolve } = await readPeople();
  // Area hints: the chats' projects, and each repo's project or the one Life inferred.
  const hints = chatAreas(truth);
  for (const [repo, r] of repos) {
    if (r.area) {
      hints.set(repo, [r.area]);
    }
  }
  const levels = levelsWith({ canon, corrections });
  const refs = refContext(
    { canon, inferred, truth },
    personallyClose(levels),
    contextPeopleBy(levels)
  );
  const onMap = refs.map.people.map((p) => ({ ...p, id: p.ref }));
  const taken = new Set(inferred.map((p) => p.id));
  const answered = answeredBy(resolve, inferred);
  const projects = new Set(truth.projects.map((p) => p.id));
  const named: InferredPerson[] = [];
  const areas = areaLookup(truth.areas);
  const madeBy = stamp(step.llm, EPISODES_PROMPT, step.run);
  let lines = await readEpisodes();
  const rereads = rereadAt(corrections, lines);
  let read = 0;
  let found = 0;
  let invalid = 0;
  // Units the model gave no verdict for: their day is read again next time.
  let missing = 0;
  // A day holding units of a source that can't be read now waits for it: read without them, its episodes would lose theirs.
  const held = new Set(
    readUnitsOf(skipped.length > 0 ? days : [])
      .filter((u) => skipped.includes(u.source))
      .map((u) => u.date)
  );
  // Oldest day first: a day sees what the days before it planned.
  for (const day of days) {
    const units = all.filter((b) => b.unit.date === day && !b.unit.drop);
    if (held.has(day) || !unread(units, verdicts, rereads)) {
      continue;
    }
    // Who they are today, as the units and the map show them.
    const earlier = earlierFor(day, lines, corrections).map((m) =>
      episodeNow(m, refOf)
    );
    // New: not judged on its current content by this prompt (or reread since); the rest go as stubs.
    const isNew = (b: Built) => !judged(b.unit, verdicts, rereads);
    // biome-ignore lint/performance/noAwaitInLoops: a day reads the episodes the day before it wrote
    const got = await step.attempt(async () => {
      // The new conversations with their words: fetched only now, for the day being read.
      const spoken = await voiceText(units.filter(isNew), resolve, truth);
      const texts = new Map(spoken.map((b) => [b.unit.id, b.text]));
      // Where he was: lifelog's stays, none on an install without it; lifelog set up but unreadable fails the attempt.
      const stays = lifelogMissing()
        ? []
        : ((await staysOf({ at: day })) ?? []);
      // Known: answered (`answeredBy`), or answered earlier in this run (one person, one id).
      const unknown = unknownIn(
        spoken,
        (s) => answered(s) || named.some((p) => p.surfaces.includes(s))
      );
      // Who an unknown speaker could be, on the map: shown with the rest of what the day involves beyond its context.
      const near = new Map(
        [...unknown.keys()].map((k) => [
          k,
          nearNames(k, onMap).map((p) => p.ref),
        ])
      );
      const involved = involvedOf(
        refs,
        new Set([
          ...units.flatMap(({ unit }) => unitNow(unit, refOf).people),
          ...namedIn(
            [...texts.values(), ...units.map((b) => b.unit.title)],
            resolve,
            refs.map.projects
          ),
          ...earlier.flatMap((m) => m.people.map((p) => p.ref)),
          ...[...near.values()].flat(),
        ])
      );
      const json = await step.ask({
        context: { ...refs.context, topics: topTopics(verdicts.values()) },
        dir: join(step.dir, day),
        input: {
          day,
          earlier: earlier.map(
            ({
              end,
              hidden,
              id,
              people,
              place,
              start,
              title,
              what,
              within,
            }) => ({
              end,
              hidden,
              id,
              people,
              place,
              start,
              title,
              what,
              within,
            })
          ),
          involved,
          stays: stays
            .toSorted((a, b) => a.arrivedAt.localeCompare(b.arrivedAt))
            .map((s) => ({
              from: localTime(s.arrivedAt),
              place: where(s),
              to: s.leftAt && localTime(s.leftAt),
            })),
          units: units.map(({ unit }) => {
            const text = texts.get(unit.id);
            return {
              areaHint: hints.get(unit.key),
              end: localTime(unit.end),
              id: unit.id,
              people: unitNow(unit, refOf).people,
              source: unit.source,
              start: localTime(unit.start),
              title: unit.title,
              ...(text === undefined
                ? { read: verdictOf(verdicts, unit)?.reason }
                : { text: head(text) }),
            };
          }),
          unknown: [...unknown].map(([key, seen]) => ({
            key,
            near: near.get(key) ?? [],
            units: seen.map((b) => b.unit.id),
          })),
        },
        prompt: EPISODES_PROMPT,
      });
      const reading = parseDay(json, {
        areas,
        day,
        earlier: new Set(earlier.map((m) => m.id)),
        hidden: new Set(earlier.flatMap((m) => (m.hidden ? [m.id] : []))),
        madeBy,
        people: new Set(refs.map.people.map((p) => p.ref)),
        resolve,
        units: new Map(units.map((b) => [b.unit.id, b.unit])),
      });
      const who = checkPeople(reading.who, {
        areas,
        at: step.now.toISOString(),
        madeBy,
        projects,
        read: (b) => head(b.text),
        taken,
        truth: new Set(truth.people.map((p) => `person:${p.id}`)),
        unknown,
      });
      return { ...reading, sent: texts.size, who };
    });
    if (got) {
      // The episodes first: the verdicts mark the day as read. A unit judged on this content by this prompt keeps its
      // verdict (the cache), whatever the new reading of its day says.
      const kept = dayFileOf(day, got, {
        corrections,
        earlier: new Set(earlier.map((m) => m.id)),
        lines,
        units: new Set(units.map((b) => b.unit.id)),
      });
      await writeDay(day, kept);
      const judgedNow = fresh(got.verdicts, units, verdicts, rereads);
      await appendVerdicts(judgedNow);
      // Who the day's unknown people are, used by the resolver from the next run on.
      await appendJsonl(INFERRED, InferredPerson, got.who);
      named.push(...got.who);
      verdicts = readVerdicts();
      missing += got.sent - judgedNow.length;
      lines = [...lines.filter((m) => m.day !== day), ...kept].toSorted(
        (a, b) => a.day.localeCompare(b.day)
      );
      read += 1;
      found += got.episodes.length;
      invalid += got.invalid;
    }
  }
  return step.end({
    agreement: agreement(
      await readLabels(),
      new Map((await readUnits()).map((u) => [u.id, u])),
      readVerdicts()
    ),
    days: days.length,
    episodes: found,
    invalid,
    missing,
    /** Who Life now thinks they are: a name and a relation, never the handles. */
    people: named.map((p) => ({ name: p.name, relation: p.relation })),
    read,
    sources,
    units: all.length,
  });
}
