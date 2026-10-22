import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { appendJsonl } from "../core/files";
import { stamp } from "../models/llm";
import type { MadeBy } from "../records/fields";
import { LocalTime, Moment } from "../records/moments";
import { type Correction, InferredPerson } from "../records/observations";
import type { MemoryLabel, Unit, Verdict } from "../records/units";
import { ChapterKind, KEEP_AT, MemoryType } from "../records/units";
import { kindOf } from "../sources";
import { closeNow } from "./closeness";
import {
  appendVerdicts,
  daysOf,
  digest,
  INFERRED,
  MOMENTS,
  momentsNow,
  readLabels,
  readMoments,
  readUnits,
  readUnitsOf,
  readVerdicts,
  type Verdicts,
  verdictKey,
  verdictOf,
} from "./ledger";
import { linkOf } from "./observe";
import { checkPeople, unknownIn } from "./people";
import { begin, checkedEntries, refContext } from "./run";
import { OWNER, type Truth } from "./truth";
import {
  areaLookup,
  areaOf,
  type Built,
  daysBefore,
  type Evidence,
  head,
  localTime,
  normalizeTopics,
  type Resolve,
  UNKNOWN,
  writeUnits,
} from "./units";
import { readPeople, unitNow } from "./who";

// `bun life memory moments`: what happened in the owner's life, day by day. For each day of the window with a unit not yet
// judged on its current content, the deep-tier model reads every unit of the day from every channel in time order,
// with the moments of the days before that may continue into it (memory-moments.v4), and returns a verdict per unit
// (memory/verdicts.jsonl: what it is, its area, topics, salience), the day's moments (memory/moments/<day>.jsonl) and
// who the day's unknown handles and names are (memory/people-inferred.jsonl).
// Extraction then reads a moment's units together (extract.ts). Units are written here too (units.ts builds them).

const MOMENTS_PROMPT = "memory-moments.v4";
// ponytail: a whole day goes in one call (about 200 KB on a busy day, each unit clipped by `head`); split the day
// into halves with the moments of the first as `earlier` if a day ever outgrows the model's context.
const TOPICS_SHOWN = 40;
/** A moment of an earlier day is shown to the next days until the day after it ends (a plan: after its date). */
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

/** The areas of the projects a chat belongs to (`Project.chats`), by Beeper chat id and by WhatsApp id. */
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

/**
 * What a reading of `day` is shown as `earlier`: its own moments from an earlier reading (to keep their ids), and those of
 * the days before that may continue into it, ending (or, for a plan, dated) no earlier than the day before.
 */
export function earlierFor(
  day: string,
  lines: Moment[],
  corrections: Correction[]
) {
  const since = daysBefore(day, CARRY_DAYS);
  return momentsNow(
    lines.filter((m) => m.day <= day),
    corrections
  ).filter((m) => m.day === day || daysOf(m)[1] >= since);
}

const Reply = z.object({
  moments: z.array(z.unknown()).default([]),
  verdicts: z.array(z.unknown()).default([]),
  who: z.array(z.unknown()).default([]),
});
const Judged = z.object({
  area: z.string().nullable().default(null),
  id: z.string(),
  // Chats and mail have no kind; the model sometimes says so with null.
  kind: ChapterKind.nullish().transform((k) => k ?? undefined),
  reason: z.string().min(1).max(300),
  salience: z.int().min(0).max(3),
  topics: z.array(z.string()).nullish(),
  type: MemoryType,
  when: z.iso.date().nullable().default(null),
});
const Said = Moment.pick({
  importance: true,
  people: true,
  status: true,
  title: true,
  why: true,
}).extend({
  copies: z.array(z.string()).default([]),
  end: z.string().nullable().default(null),
  id: z.string(),
  place: z.string().nullable().default(null),
  start: z.string().nullable().default(null),
  units: z.array(z.string()),
});
const at = (s: string | null) => (LocalTime.safeParse(s).success ? s : null);

/**
 * Code's last word on a verdict's salience: commits 1 at most (never extracted), a unit he marked "hey Life" 3, an
 * agent's report at least KEEP_AT (always read, for what it may close).
 */
export function saliencyOf(u: Unit, salience: number) {
  const kind = kindOf(u.source);
  if (kind === "repo") {
    return Math.min(salience, 1);
  }
  if (u.marked) {
    return 3;
  }
  return kind === "agent" ? Math.max(salience, KEEP_AT) : salience;
}

/** The verdicts of a day's reply for units of that day, once each, their salience `saliencyOf`. */
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
      ({ area, id, salience, topics, ...rest }): [string, Verdict] => {
        const u = ctx.units.get(id) as Unit;
        return [
          id,
          {
            ...rest,
            area: areaOf(area, ctx.areas),
            hash: u.hash,
            madeBy: ctx.madeBy,
            salience: saliencyOf(u, salience),
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

/**
 * The model's reply for one day, checked: a verdict for a unit of the day (its content hash in `units`), its area one
 * of `areas` (by id or name) or null, commits at salience 1 at most (never extracted); a moment of the day's units,
 * people resolved through the map (the owner left out), an earlier moment's id kept, a new one minted from the day and its
 * units. Anything else is dropped; `invalid` counts the verdicts dropped.
 */
export function parseDay(
  reply: unknown,
  ctx: {
    areas: Map<string, string>;
    day: string;
    earlier: Set<string>;
    madeBy: MadeBy;
    /** The person refs the model was given. */
    people: Set<string>;
    resolve: Resolve;
    units: Map<string, Unit>;
  }
) {
  const said = Reply.parse(reply);
  const verdicts = verdictsOf(said.verdicts, ctx);
  const found = new Map<string, Moment>();
  for (const raw of said.moments) {
    const r = Said.safeParse(raw);
    const units = r.success ? r.data.units.filter((u) => ctx.units.has(u)) : [];
    if (!(r.success && units.length > 0)) {
      continue;
    }
    const m = r.data;
    const people = m.people.flatMap(({ ref, role }) => {
      const p = personOf(ref, ctx);
      return p ? [{ ref: p, role }] : [];
    });
    // Minted from what it is: the day, its start and units (its title too when two moments share those).
    const key = [ctx.day, m.start ?? "", ...units.toSorted()];
    const mint = (k: string[]) => `mom_${digest("sha1", k.join("|"), 12)}`;
    let id = ctx.earlier.has(m.id) ? m.id : mint(key);
    if (found.has(id)) {
      id = mint([...key, m.title]);
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
      status: m.status,
      title: m.title,
      units,
      why: m.why,
    });
  }
  return {
    invalid: said.verdicts.length - verdicts.size,
    moments: [...found.values()],
    verdicts: [...verdicts.values()],
    who: said.who,
  };
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);

/**
 * How the verdicts compare with the owner's labels (memory/labels.jsonl): a unit is "kept" at salience KEEP_AT or more,
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
      ? [{ kept: !!v && v.salience >= KEEP_AT, matters: l.matters }]
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

/** Whether a unit has a verdict on its current content by this prompt: the cache. */
const judged = (u: Unit, verdicts: Verdicts) =>
  verdictOf(verdicts, u)?.madeBy.prompt === MOMENTS_PROMPT;

/** Whether a day must be read: one of its units has no verdict on its current content by this prompt. */
export const unread = (units: Built[], verdicts: Verdicts) =>
  units.some((b) => !judged(b.unit, verdicts));

/** The verdicts of a reading of the day worth keeping: for the units not judged yet on their content (the cache). */
export const fresh = (said: Verdict[], units: Built[], verdicts: Verdicts) => {
  const byId = new Map(units.map((b) => [b.unit.id, b.unit]));
  return said.filter((v) => {
    const u = byId.get(v.unit);
    return u !== undefined && !judged(u, verdicts);
  });
};

async function writeDay(day: string, list: Moment[]) {
  await mkdir(MOMENTS, { recursive: true });
  await Bun.write(
    join(MOMENTS, `${day}.jsonl`),
    list.map((m) => `${JSON.stringify(Moment.parse(m))}\n`).join("")
  );
}

/** Reads the days of `evidence`'s units (its window, `gather`), oldest first, each one not read yet. */
export async function moments(evidence: Evidence) {
  const step = await begin("moments", "deep", {
    prompt: MOMENTS_PROMPT,
    ...evidence.window,
  });
  const { built: all, failed, read: sources, repos, skipped, truth } = evidence;
  // A source that could not be read counts as a failure: the night must not commit a partial day.
  step.stats.failed += failed.length;
  const days = [...new Set(all.map((b) => b.unit.date))].sort();
  // Units first (code output, rebuildable); not when a source failed: the files would lose that source's units.
  if (failed.length === 0) {
    await writeUnits(
      days,
      all.map((b) => b.unit),
      (u) => skipped.includes(u.source)
    );
  }
  const [verdicts, { corrections, inferred, refOf, resolve }] =
    await Promise.all([readVerdicts(), readPeople()]);
  // Area hints: the chats' projects, and each repo's project or Life's guess.
  const hints = chatAreas(truth);
  for (const [repo, r] of repos) {
    if (r.area) {
      hints.set(repo, [r.area]);
    }
  }
  const context = refContext(truth, inferred, await closeNow());
  const taken = new Set(inferred.map((p) => p.id));
  const projects = new Set(truth.projects.map((p) => p.id));
  const named: InferredPerson[] = [];
  const areas = areaLookup(truth.areas);
  const madeBy = stamp(step.llm, MOMENTS_PROMPT, step.run);
  let lines = await readMoments();
  let read = 0;
  let found = 0;
  let invalid = 0;
  // Units the model gave no verdict for: their day is read again next time.
  let missing = 0;
  // A day holding units of a source that can't be read now waits for it: read without them, its moments would lose theirs.
  const held = new Set(
    readUnitsOf(skipped.length > 0 ? days : [])
      .filter((u) => skipped.includes(u.source))
      .map((u) => u.date)
  );
  // Oldest day first: a day sees what the days before it planned.
  for (const day of days) {
    const units = all.filter((b) => b.unit.date === day && !b.unit.drop);
    if (held.has(day) || !unread(units, verdicts)) {
      continue;
    }
    const earlier = earlierFor(day, lines, corrections);
    // Known: on the map, inferred confidently, or answered earlier in this run (one person, one id).
    const unknown = unknownIn(
      units,
      (s) => resolve(s) !== null || named.some((p) => p.surfaces.includes(s))
    );
    // biome-ignore lint/performance/noAwaitInLoops: a day reads the moments the day before it wrote
    const got = await step.attempt(async () => {
      const json = await step.ask({
        context: { ...context, topics: topTopics(verdicts.values()) },
        dir: join(step.dir, day),
        input: {
          day,
          earlier: earlier.map(
            ({ id, people, place, start, status, title }) => ({
              id,
              people,
              place,
              start,
              status,
              title,
            })
          ),
          units: units.map(({ text, unit }) => ({
            areaHint: hints.get(unit.key),
            end: localTime(unit.end),
            id: unit.id,
            people: unitNow(unit, refOf).people,
            source: unit.source,
            start: localTime(unit.start),
            text: head(text),
            title: unit.title,
          })),
          unknown: [...unknown].map(([key, seen]) => ({
            key,
            units: seen.map((b) => b.unit.id),
          })),
        },
        prompt: MOMENTS_PROMPT,
      });
      const reading = parseDay(json, {
        areas,
        day,
        earlier: new Set(earlier.map((m) => m.id)),
        madeBy,
        people: new Set(context.people.map((p) => p.ref)),
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
        unknown,
      });
      return { ...reading, who };
    });
    if (got) {
      // The moments first: the verdicts mark the day as read. A unit judged on this content by this prompt keeps its
      // verdict (the cache), whatever the new reading of its day says.
      await writeDay(day, got.moments);
      const kept = fresh(got.verdicts, units, verdicts);
      await appendVerdicts(kept);
      // Who the day's unknown people are, used by the resolver from the next run on.
      await appendJsonl(INFERRED, InferredPerson, got.who);
      named.push(...got.who);
      for (const v of kept) {
        verdicts.set(verdictKey(v.unit, v.hash), v);
      }
      missing += units.length - got.verdicts.length;
      lines = [...lines.filter((m) => m.day !== day), ...got.moments].toSorted(
        (a, b) => a.day.localeCompare(b.day)
      );
      read += 1;
      found += got.moments.length;
      invalid += got.invalid;
    }
  }
  return step.end({
    agreement: agreement(
      await readLabels(),
      new Map((await readUnits()).map((u) => [u.id, u])),
      await readVerdicts()
    ),
    days: days.length,
    invalid,
    missing,
    moments: found,
    /** Who Life now thinks they are: a name and a relation, never the handles. */
    people: named.map((p) => ({ name: p.name, relation: p.relation })),
    read,
    sources,
    units: all.length,
  });
}
