import { join } from "node:path";
import { daysBefore } from "../core/clock";
import { appendJsonl, rowsOf } from "../core/files";
import { packed } from "../core/lists";
import { stamp } from "../models/llm";
import type { Episode } from "../records/episode";
import {
  Extracted,
  Observation,
  Supersession,
  Unresolved,
} from "../records/observation";
import { KEEP_AT, SEARCHABLE_AT } from "../records/unit";
import { isActivity } from "../sources/contract";
import type { LifelogConversation } from "../sources/lifelog";
import { contextPeopleBy, levelsWith, personallyClose } from "./closeness";
import {
  EXTRACTED,
  episodesNow,
  isRereadSince,
  latestBy,
  OBSERVATIONS,
  observationStatusOf,
  readBy,
  readEpisodes,
  readVerdicts,
  rereadAt,
  SUPERSESSIONS,
  UNRESOLVED,
  type Verdicts,
  verdictOf,
} from "./memory-files";
import { involvedOf, refContext } from "./model-context";
import { parseObservations, type Reject, type Source } from "./quote-check";
import { othersIn } from "./read-truth";
import { begin, inBatches } from "./run";
import { kindOf } from "./sources";
import { areaLookup } from "./tags";
import { type Built, type Evidence, MARKED, UNKNOWN } from "./units";
import {
  episodeNow,
  namedIn,
  observationsNow,
  readPeople,
  unitNow,
  who,
} from "./who";
import { chatLines, spokenLines } from "./words";
import { localTime } from "./zones";

// `bun life memory extract`: stage 2 of the memory cascade. For every unit kept (importance >= KEEP_AT, i.e. 2, episodes.ts),
// the deep-tier model reads the episode it belongs to (episodes.ts: every unit of it, from every channel and day, from
// the day before its first unit to read; groupsOf) with
// the earlier facts about its people, and returns observations; code checks each quote against the source and each
// entity against the candidate list, then appends them to memory/observations/<yyyy-mm>.jsonl, and the earlier facts
// the episode's lines show are no longer true to memory/supersessions.jsonl. Nothing is sent.

const EXTRACT_PROMPT = "memory-extract.v5";
/** Characters of unit text per call: whole episodes, as many as fit. */
const BUDGET = 40_000;
/** Earlier facts shown with an episode: about its people, from the 14 days before it, newest 40 (and the slots of `priorFor`). */
const PRIOR_DAYS = 14;
const PRIOR_MAX = 40;
/** What lasts between him and someone close (`about_a_person` facts), shown from this far back, at most this many. */
const BOND_DAYS = 365;
const BOND_MAX = 10;
/** Facts from the episode's own units, of any age (a plan carried to its day), at most this many. */
const EPISODE_MAX = 20;

/**
 * The ids of the conversations lifelog has settled (the contract's `closed`, its own signal, never a timing rule of
 * Life's): their units are final enough to read before the day is over.
 */
export const closedConversations = (conversations: LifelogConversation[]) =>
  new Set(conversations.filter((c) => c.closed).map((c) => c.id));

const size = (s: Source) => s.lines.reduce((n, l) => n + l.text.length, 0);

/** What one episode gives extraction to read: the episode (null for kept units in no episode) and its units. */
export interface Group {
  episode: Episode | null;
  units: Built[];
}
/** Who a group shows taking part: its units' people and its episode's, the owner among them. */
const peopleOf = (g: Group) => [
  ...g.units.flatMap((b) => b.unit.people),
  ...(g.episode?.people.map((p) => p.ref) ?? []),
];

/**
 * What to read, episode by episode (`episodes` as they stand, `episodesNow`): every episode holding a pending unit, with
 * its units worth a searchable line (a copy never, returned apart); then the pending units in no episode, a day at a
 * time. A unit in several episodes is read once, with its episode (`readBy`), so a question is read with its answer and
 * the unit's earlier facts give way to the new reading.
 */
export function groupsOf(
  pending: Built[],
  built: Built[],
  verdicts: Verdicts,
  episodes: Episode[]
) {
  const byId = new Map(built.map((b) => [b.unit.id, b]));
  const waiting = new Set(pending.map((b) => b.unit.id));
  // A copy of another unit is never read, in its episode or alone: it is marked read with nothing in it.
  const copied = new Set(episodes.flatMap((m) => m.copies));
  const worth = (id: string) => {
    const b = byId.get(id);
    return b &&
      !isActivity(kindOf(b.unit.source)) &&
      !(b.unit.drop || copied.has(id)) &&
      (verdictOf(verdicts, b.unit)?.importance ?? 0) >= SEARCHABLE_AT
      ? [b]
      : [];
  };
  const read = episodes.map((episode) => ({
    episode,
    units: episode.units
      .flatMap(worth)
      .toSorted((a, b) => a.unit.date.localeCompare(b.unit.date)),
  }));
  const byEpisode = readBy(episodes);
  const claimed = new Set(read.flatMap((r) => r.units.map((b) => b.unit.id)));
  const groups: Group[] = read.flatMap(({ episode, units }) => {
    const own = units.filter((b) => byEpisode.get(b.unit.id) === episode);
    const first = own.find((b) => waiting.has(b.unit.id))?.unit.date;
    // Read from the day before its first pending unit, so a new day does not re-read a whole trip: the facts of its
    // earlier days come as priors (`priorFor`).
    return first
      ? [
          {
            episode,
            units: own.filter((b) => b.unit.date >= daysBefore(first, 1)),
          },
        ]
      : [];
  });
  const rest = pending.filter(
    (b) => !(copied.has(b.unit.id) || claimed.has(b.unit.id))
  );
  for (const units of Map.groupBy(rest, (b) => b.unit.date).values()) {
    groups.push({ episode: null, units });
  }
  return { copies: pending.filter((b) => copied.has(b.unit.id)), groups };
}

/** The characters of a group's lines: what a call of groups is packed by (`packed`). */
const groupSize = (g: { sources: Source[] }) =>
  g.sources.reduce((n, x) => n + size(x), 0);

/**
 * A group cut between its days into runs that fit the budget (a day is never cut): an episode over the budget alone, a
 * long trip read whole, is read too thinly (one call wrote 15 facts for 48 units where day by day wrote 39).
 */
export function byDays<T extends Group & { sources: Source[] }>(
  group: T,
  budget = BUDGET
) {
  const days = Map.groupBy(group.sources, (s) => s.unit.date).values();
  return packed(
    [...days].map((sources) => ({ sources })),
    budget,
    groupSize
  ).map((run) => {
    const sources = run.flatMap((d) => d.sources);
    const ids = new Set(sources.map((s) => s.unit.id));
    return {
      ...group,
      sources,
      units: group.units.filter((b) => ids.has(b.unit.id)),
    };
  });
}

/**
 * The units to read: kept (importance >= KEEP_AT) on their current content, and not yet extracted by this prompt
 * from that same content (the cache: unit content hash + prompt version, from memory/extracted.jsonl), unless the
 * owner said a unit was read wrong after it was (`rereads`, his `reread` corrections). Who someone is needs no new
 * reading: the readers resolve a fact's author and entities as of today (`aboutNow`). `unkept`: units read before
 * that their latest verdict no longer keeps (content changed, or a re-read judged them lower): their facts are
 * replaced by none, so none stays shown; one kept again is read again (its `unkept` line is no reading).
 */
export function toExtract(
  built: Built[],
  verdicts: Verdicts,
  ledger: Extracted[],
  prompt = EXTRACT_PROMPT,
  rereads = new Map<string, string>()
) {
  // The latest reading of each unit's content by this prompt.
  const done = latestBy(
    ledger.filter((e) => e.prompt === prompt),
    (e) => `${e.unit}|${e.unitHash}`
  );
  // Settled: the latest line for this content is after his last re-read; read: and it is a reading, not `unkept`.
  const settled = ({ unit }: Built) => {
    const e = done.get(`${unit.id}|${unit.hash}`);
    return e && !isRereadSince(rereads, unit.id, e.at) ? e : undefined;
  };
  const readAs = (b: Built) => !!settled(b) && !settled(b)?.unkept;
  const readBefore = new Set(ledger.map((e) => e.unit));
  let stale = 0;
  const kept: { b: Built; reason: string }[] = [];
  const unkept: Built[] = [];
  for (const b of built) {
    // A unit a code rule drops today stays dropped, whatever an older verdict said.
    if (b.unit.drop) {
      continue;
    }
    const v = verdictOf(verdicts, b.unit);
    if (!v) {
      stale += 1;
    } else if (v.importance >= KEEP_AT) {
      kept.push({ b, reason: v.reason });
    } else if (readBefore.has(b.unit.id) && !settled(b)) {
      unkept.push(b);
    }
  }
  const pending = kept.filter(({ b }) => !readAs(b));
  return { kept, pending, stale, unkept };
}

async function appendObservations(list: Observation[]) {
  for (const [month, obs] of Map.groupBy(list, (o) => o.date.slice(0, 7))) {
    // biome-ignore lint/performance/noAwaitInLoops: one file per month, appended in order
    await appendJsonl(join(OBSERVATIONS, `${month}.jsonl`), Observation, obs);
  }
}

/**
 * Calls in lanes, several lanes at once (`inBatches`) and a lane's calls one after another: the calls holding one episode (cut
 * between its days) share a lane, in order, so its later days see what its earlier ones wrote.
 */
export function lanesOf<T extends { episode: Episode | null }[]>(calls: T[]) {
  const index = new Map(calls.map((c, i) => [c, i]));
  const laneOf = new Map<string, T[]>();
  const lanes = new Set<T[]>();
  for (const call of calls) {
    const ids = call.flatMap((g) => (g.episode ? [g.episode.id] : []));
    const met = new Set(
      ids.flatMap((id) => {
        const l = laneOf.get(id);
        return l ? [l] : [];
      })
    );
    const lane = [...[...met].flat(), call].toSorted(
      (a, b) => (index.get(a) ?? 0) - (index.get(b) ?? 0)
    );
    for (const l of met) {
      lanes.delete(l);
    }
    lanes.add(lane);
    for (const [id, l] of laneOf) {
      laneOf.set(id, met.has(l) ? lane : l);
    }
    for (const id of ids) {
      laneOf.set(id, lane);
    }
  }
  return [...lanes].toSorted(
    (a, b) => (index.get(a[0] as T) ?? 0) - (index.get(b[0] as T) ?? 0)
  );
}

/**
 * Earlier facts for a group, newest first, shown to the model as a reading to correct, never as evidence: about its
 * people from the two weeks before it, and about the owner alone from its day and the day before. `shown` are the active
 * facts (with those `run` wrote already), and the retired ones with the unit of what retired them. `reread` are the units
 * this run reads again: their earlier facts are replaced, or about to be, so none is shown, and one they retired is
 * offered again. Beyond those, each in its own slot so recent facts never crowd it out: the facts of the episode's own
 * units at any age, and the `about_a_person` facts of the last year about its people `close` to him (what is between them
 * lasts, and a newer fact must replace it).
 */
export function priorFor(
  group: Group,
  shown: { by?: string; o: Observation }[],
  reread: Set<string>,
  run: string,
  close: ReadonlySet<string>,
  max = PRIOR_MAX
) {
  const day = group.units.at(-1)?.unit.date ?? "";
  const people = new Set(othersIn(peopleOf(group)));
  const about = (o: Observation) =>
    o.date >= daysBefore(day, PRIOR_DAYS) &&
    (o.entities.some((e) => people.has(e)) ||
      (othersIn(o.entities).length === 0 && o.date >= daysBefore(day, 1)));
  const own = new Set(group.episode?.units);
  const ofEpisode = (o: Observation) => own.has(o.unit);
  const lasting = (o: Observation) =>
    o.type === "about_a_person" &&
    o.date >= daysBefore(day, BOND_DAYS) &&
    o.entities.some((e) => people.has(e) && close.has(e));
  const slots: [(o: Observation) => boolean, number][] = [
    [about, max],
    [ofEpisode, EPISODE_MAX],
    [lasting, BOND_MAX],
  ];
  const candidates = shown
    .filter(
      ({ by, o }) =>
        o.date <= day &&
        (o.madeBy.run === run || !reread.has(o.unit)) &&
        (!by || reread.has(by)) &&
        slots.some(([fits]) => fits(o))
    )
    .map(({ o }) => o)
    .toSorted((a, b) => b.at.localeCompare(a.at));
  const taken = new Set<Observation>();
  return slots.flatMap(([fits, n]) => {
    const got = candidates.filter((o) => !taken.has(o) && fits(o)).slice(0, n);
    for (const o of got) {
      taken.add(o);
    }
    return got;
  });
}

/** Extracts the kept units of `evidence` (its window, `gather`) not read yet by this prompt. */
export async function extract(evidence: Evidence) {
  const step = await begin(
    "extract",
    "deep",
    { prompt: EXTRACT_PROMPT, ...evidence.window },
    evidence.engine
  );
  const { now, today } = step;
  const { built, conversations, failed, truth } = evidence;
  // A source that could not be read counts as a failure: the night must not commit a partial day.
  step.stats.failed += failed.length;
  // Today is not over: its chats are still growing, so they wait for tomorrow; only closed lifelog conversations go now.
  const closed = closedConversations(conversations);
  const verdicts = readVerdicts();
  const people = await readPeople();
  const { corrections, refOf, resolve } = people;
  // Who each unit is with as of now: the people the episodes step just inferred included.
  const inWindow = built
    .filter(
      (b) =>
        b.unit.date < today ||
        (kindOf(b.unit.source) === "voice" && closed.has(b.unit.key))
    )
    .map((b) => ({
      ...b,
      unit: unitNow(b.unit, refOf),
    }));
  const [written, { observations: known, statusInputs }] = await Promise.all([
    readEpisodes(),
    observationsNow(people),
  ]);
  const { kept, pending, stale, unkept } = toExtract(
    inWindow,
    verdicts,
    rowsOf(EXTRACTED, Extracted),
    EXTRACT_PROMPT,
    rereadAt(corrections, written)
  );
  const unitOf = new Map(known.map((o) => [o.id, o.unit]));
  const shown = known.flatMap((o) => {
    const s = observationStatusOf(o, statusInputs);
    if (s.state === "retired") {
      // One he said is outdated (retired by itself: a rating or a correction) is closed for good.
      return s.by === o.id ? [] : [{ by: unitOf.get(s.by), o }];
    }
    return s.state === "active" ? [{ o }] : [];
  });
  const { copies, groups } = groupsOf(
    pending.map((p) => p.b),
    inWindow,
    verdicts,
    // An episode the owner said is wrong groups nothing; its people are who they are today.
    episodesNow(written, corrections).map((m) => episodeNow(m, refOf))
  );

  const read = groups.flatMap((g) => g.units);
  const reread = new Set([...read, ...copies].map((b) => b.unit.id));
  const spoken = await spokenLines(
    read.map((b) => b.unit),
    resolve,
    truth
  );
  const sourceOf = (b: Built): Source[] => {
    // A unit is read whole: one over the budget goes in a call of its own (`packed`).
    const all =
      kindOf(b.unit.source) === "voice"
        ? (spoken.get(b.unit.id) ?? [])
        : chatLines(b, resolve);
    return all.length > 0 ? [{ lines: all, unit: b.unit }] : [];
  };
  const calls = packed(
    groups
      .flatMap((g) => byDays({ ...g, sources: g.units.flatMap(sourceOf) }))
      // In time order: a call sees the facts its lane's calls and the lanes before wrote (`lanesOf`).
      .toSorted((a, b) =>
        (a.units[0]?.unit.date ?? "").localeCompare(b.units[0]?.unit.date ?? "")
      ),
    BUDGET,
    groupSize
  );
  const lanes = lanesOf(calls);

  const levels = levelsWith(people);
  const close = personallyClose(levels);
  const refs = refContext(people, close, contextPeopleBy(levels));
  // Refs are checked against the whole directory, not only what a call was shown.
  const candidates = new Set(
    [refs.directory.people, refs.directory.projects].flatMap((l) =>
      l.map((x) => x.ref)
    )
  );

  const madeBy = stamp(step.llm, EXTRACT_PROMPT, step.run);
  const reasons = new Map(kept.map(({ b, reason }) => [b.unit.id, reason]));
  const observations: Observation[] = [];
  const retired: Supersession[] = [];
  const rejects: Reject[] = [];
  const unresolved: Unresolved[] = [];
  const finished: Source[] = [];
  const at = now.toISOString();
  // One bad call costs only its units: they are not marked extracted, so the next run retries them.
  const one = (call: (typeof calls)[number], bdir: string) =>
    step.attempt(async () => {
      const sources = call.flatMap((g) => g.sources);
      // What this run wrote is the reading now, and what it retired is gone.
      const gone = new Set(retired.map((r) => r.observation));
      const standingNow = [
        ...shown,
        ...observations.map((o) => ({ o })),
      ].filter(({ o }) => !gone.has(o.id));
      const prior = [
        ...new Map(
          call
            .flatMap((g) => priorFor(g, standingNow, reread, step.run, close))
            .map((o) => [o.id, o])
        ).values(),
      ];
      const input = {
        // Not the episode's `what`: extraction reads the units; the episode only groups them (its prompt's meaning, v5).
        episodes: call.map(({ episode: m, sources: ss }) => ({
          id: m?.id ?? "none",
          people: m?.people ?? [],
          place: m?.place ?? null,
          start: m?.start ?? null,
          title: m?.title ?? "units in no episode",
          units: ss.map(({ lines: ls, unit }) => ({
            id: unit.id,
            lines: ls.map(
              (l, n) =>
                `[${n}] ${localTime(l.at)} ${who(l)}${unit.marked?.includes(l.ref) ? " (marked)" : ""}: ${l.text}`
            ),
            people: unit.people,
            source: unit.source,
            title: unit.title,
            triage: unit.marked
              ? `${MARKED} Write every fact in the lines marked (marked), each at its own importance. ${reasons.get(unit.id) ?? ""}`
              : reasons.get(unit.id),
          })),
        })),
        // Who and what the call involves beyond its context: its people, whom its lines name, its earlier facts' refs.
        involved: involvedOf(
          refs,
          new Set([
            ...call.flatMap(peopleOf),
            ...namedIn(
              sources.flatMap((s) => s.lines.map((l) => l.text)),
              resolve,
              refs.directory.projects
            ),
            ...prior.flatMap((o) => o.entities),
          ])
        ),
        prior: prior.map((o) => ({ date: o.date, id: o.id, text: o.text })),
      };
      const json = await step.ask({
        context: refs.context,
        dir: bdir,
        input,
        prompt: EXTRACT_PROMPT,
      });
      const parsed = parseObservations(json, {
        areas: areaLookup(truth.areas),
        candidates,
        madeBy,
        prior: new Map(prior.map((o) => [o.id, o])),
        resolve,
        sources: new Map(sources.map((x) => [x.unit.id, x])),
      });
      observations.push(...parsed.observations);
      rejects.push(...parsed.rejects);
      for (const { by, old } of parsed.replaced) {
        retired.push({
          at,
          by: by.id,
          madeBy,
          observation: old.id,
          schemaVersion: 1,
          validTo: by.validFrom ?? by.date,
          why: by.text.slice(0, 300),
        });
      }
      const date = new Map(sources.map((x) => [x.unit.id, x.unit.date]));
      for (const u of parsed.unresolved) {
        unresolved.push({
          at,
          date: date.get(u.unit) ?? today,
          observation: u.observation,
          schemaVersion: 1,
          surface: u.surface,
          unit: u.unit,
          via: "model",
        });
      }
      finished.push(...sources);
    });
  await inBatches(lanes, step, async (lane, bdir) => {
    for (const [k, call] of lane.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: a lane's calls go in order, each seeing the facts of the last
      await one(call, k === 0 ? bdir : `${bdir}-${k}`);
    }
  });
  // Names lifelog gave a voice that the directory doesn't know (a chat's unknown senders are handles, not names).
  for (const { unit } of finished.filter(
    (s) => kindOf(s.unit.source) === "voice"
  )) {
    for (const p of unit.people.filter((x) => x.startsWith(UNKNOWN))) {
      unresolved.push({
        at,
        date: unit.date,
        schemaVersion: 1,
        surface: p.slice(UNKNOWN.length),
        unit: unit.id,
        via: "speaker",
      });
    }
  }

  await appendObservations(observations);
  await appendJsonl(SUPERSESSIONS, Supersession, retired);
  const line = (unit: Built["unit"], found: number) => ({
    at,
    observations: found,
    prompt: EXTRACT_PROMPT,
    run: step.run,
    schemaVersion: 1 as const,
    unit: unit.id,
    unitHash: unit.hash,
  });
  const perUnit = new Map<string, number>();
  for (const o of observations) {
    perUnit.set(o.unit, (perUnit.get(o.unit) ?? 0) + 1);
  }
  await appendJsonl(EXTRACTED, Extracted, [
    ...[...finished, ...copies].map(({ unit }) =>
      line(unit, perUnit.get(unit.id) ?? 0)
    ),
    // An unkept unit's line has no facts: its earlier ones are replaced (`isCurrent`, memory-files.ts).
    ...unkept.map(({ unit }) => ({ ...line(unit, 0), unkept: true as const })),
  ]);
  await appendJsonl(UNRESOLVED, Unresolved, unresolved);
  await Bun.write(
    join(step.dir, "rejects.jsonl"),
    rejects.map((r) => `${JSON.stringify(r)}\n`).join("")
  );
  return step.end({
    added: observations.length,
    cached: kept.length - pending.length,
    episodes: groups.filter((g) => g.episode).length,
    kept: kept.length,
    read: finished.length,
    rejects: rejects.length,
    retired: retired.length,
    stale,
    unkept: unkept.length,
  });
}
