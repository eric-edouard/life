import { join } from "node:path";
import { stamp } from "../llm";
import {
  Extracted,
  KEEP_AT,
  type Moment,
  Observation,
  SEARCHABLE_AT,
  Supersession,
  Unresolved,
} from "../schema";
import {
  type LifelogConversation,
  turnsBetween,
  withStore,
} from "../sources/lifelog";
import { othersIn } from "../truth";
import { closeNow } from "./closeness";
import {
  appendJsonl,
  EXTRACTED,
  latestBy,
  momentsNow,
  OBSERVATIONS,
  readMoments,
  readVerdicts,
  rereadAt,
  rowsOf,
  SUPERSESSIONS,
  stateOf,
  UNRESOLVED,
  type Verdicts,
  verdictOf,
} from "./ledger";
import { parseObservations, type Reject, type Source, who } from "./observe";
import { chatLines, transcripts, voiceLines } from "./raw";
import { begin, inBatches, refContext } from "./run";
import {
  areaLookup,
  type Built,
  daysBefore,
  type Evidence,
  lifelogNames,
  localTime,
  nameIndex,
  within,
} from "./units";
import { observationsNow, readPeople, UNKNOWN } from "./who";

// `bun life memory extract`: stage 2 of the memory cascade. For every unit kept (salience >= KEEP_AT, i.e. 2, moments.ts),
// the deep-tier model reads the moment it belongs to (moments.ts: every unit of it, from every channel and day, from
// the day before its first unit to read; groupsOf) with
// the earlier facts about its people, and returns observations; code checks each quote against the source and each
// entity against the candidate list, then appends them to memory/observations/<yyyy-mm>.jsonl, and the earlier facts
// the moment's lines show are no longer true to memory/supersessions.jsonl. Nothing is sent.

const EXTRACT_PROMPT = "memory-extract.v6";
/** Characters of unit text per call: whole moments, as many as fit. */
const BUDGET = 40_000;
const UNIT_MAX = 30_000;
/** A conversation this quiet and summarized is closed: its units are final enough to read before the day is over. */
const QUIET_MS = 60 * 60_000;
/** Earlier facts shown with a moment: about its people, from the 14 days before it, newest 40. */
const PRIOR_DAYS = 14;
const PRIOR_MAX = 40;
/** What lasts between him and someone close (`person` facts), shown from this far back, at most this many. */
const BOND_DAYS = 365;
const BOND_MAX = 10;

/** The ids of the lifelog conversations that are summarized and have been quiet for an hour. */
export function closedConversations(
  conversations: LifelogConversation[],
  now: Date
) {
  return new Set(
    conversations
      .filter(
        (c) =>
          c.state === "summarized" &&
          Date.parse(c.endedAt) <= now.getTime() - QUIET_MS
      )
      .map((c) => c.id)
  );
}

const size = (s: Source) => s.lines.reduce((n, l) => n + l.text.length, 0);

/** What one moment gives extraction to read: the moment (null for kept units in no moment) and its units. */
export interface Group {
  moment: Moment | null;
  units: Built[];
}

/**
 * What to read, moment by moment (`moments` as they stand, `momentsNow`): every moment holding a pending unit, with
 * its units worth a searchable line (a copy never, returned apart); then the pending units in no moment, a day at a
 * time. A unit in several moments is read once, with the one reaching furthest forward (of those, the smallest), so a
 * question is read with its answer and the unit's earlier facts give way to the new reading.
 */
export function groupsOf(
  pending: Built[],
  built: Built[],
  verdicts: Verdicts,
  moments: Moment[]
) {
  const byId = new Map(built.map((b) => [b.unit.id, b]));
  const waiting = new Set(pending.map((b) => b.unit.id));
  // A copy of another unit is never read, in its moment or alone: it is marked read with nothing in it.
  const copied = new Set(moments.flatMap((m) => m.copies));
  const worth = (id: string) => {
    const b = byId.get(id);
    return b &&
      b.unit.source !== "git" &&
      !(b.unit.drop || copied.has(id)) &&
      (verdictOf(verdicts, b.unit)?.salience ?? 0) >= SEARCHABLE_AT
      ? [b]
      : [];
  };
  const read = moments.map((moment) => ({
    moment,
    units: moment.units
      .flatMap(worth)
      .toSorted((a, b) => a.unit.date.localeCompare(b.unit.date)),
  }));
  // Furthest last, and of the same reach the smallest last: the last moment to claim a unit keeps it.
  const readBy = new Map(
    read
      .toSorted(
        (a, b) =>
          a.moment.day.localeCompare(b.moment.day) ||
          b.units.length - a.units.length
      )
      .flatMap(({ moment, units }) => units.map((b) => [b.unit.id, moment]))
  );
  const groups: Group[] = read.flatMap(({ moment, units }) => {
    const own = units.filter((b) => readBy.get(b.unit.id) === moment);
    const first = own.find((b) => waiting.has(b.unit.id))?.unit.date;
    // ponytail: read from the day before its first pending unit, so a new day does not re-read a whole trip; a moment
    // whose ask and answer are further apart needs a summary of its earlier days.
    return first
      ? [
          {
            moment,
            units: own.filter((b) => b.unit.date >= daysBefore(first, 1)),
          },
        ]
      : [];
  });
  const rest = pending.filter(
    (b) => !(copied.has(b.unit.id) || readBy.has(b.unit.id))
  );
  for (const units of Map.groupBy(rest, (b) => b.unit.date).values()) {
    groups.push({ moment: null, units });
  }
  return { copies: pending.filter((b) => copied.has(b.unit.id)), groups };
}

/** Groups packed into calls of at most `budget` characters of lines; a group is never split. */
export function packed<T extends { sources: Source[] }>(
  groups: T[],
  budget = BUDGET
) {
  const out: T[][] = [];
  let current: T[] = [];
  let chars = 0;
  for (const g of groups) {
    const n = g.sources.reduce((k, x) => k + size(x), 0);
    if (current.length > 0 && chars + n > budget) {
      out.push(current);
      current = [];
      chars = 0;
    }
    current.push(g);
    chars += n;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

/**
 * A group cut between its days into runs that fit the budget (a day is never cut): a moment over the budget alone, a
 * long trip read whole, is read too thinly (one call wrote 15 facts for 48 units where day by day wrote 39).
 */
export function byDays<T extends Group & { sources: Source[] }>(
  group: T,
  budget = BUDGET
) {
  const days = Map.groupBy(group.sources, (s) => s.unit.date).values();
  return packed(
    [...days].map((sources) => ({ sources })),
    budget
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
 * The units to read: kept (salience >= KEEP_AT) on their current content, and not yet extracted by this prompt
 * from that same content (the cache: unit content hash + prompt version, from memory/extracted.jsonl), unless the
 * owner said a unit was read wrong after it was (`rereads`, his `reread` corrections). Who someone is needs no new
 * reading: the readers resolve a fact's author and entities as of today (`aboutNow`).
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
  const readAs = ({ unit }: Built) => {
    const e = done.get(`${unit.id}|${unit.hash}`);
    const since = rereads.get(unit.id);
    return !!e && !(since && Date.parse(since) > Date.parse(e.at));
  };
  let stale = 0;
  const kept: { b: Built; reason: string }[] = [];
  for (const b of built) {
    // A unit a code rule drops today stays dropped, whatever an older verdict said.
    if (b.unit.drop) {
      continue;
    }
    const v = verdictOf(verdicts, b.unit);
    if (!v) {
      stale += 1;
    } else if (v.salience >= KEEP_AT) {
      kept.push({ b, reason: v.reason });
    }
  }
  const pending = kept.filter(({ b }) => !readAs(b));
  return { kept, pending, stale };
}

async function appendObservations(list: Observation[]) {
  for (const [month, obs] of Map.groupBy(list, (o) => o.date.slice(0, 7))) {
    // biome-ignore lint/performance/noAwaitInLoops: one file per month, appended in order
    await appendJsonl(join(OBSERVATIONS, `${month}.jsonl`), Observation, obs);
  }
}

/**
 * Calls in lanes, run PARALLEL lanes at a time and a lane's calls one after another: the calls holding one moment (cut
 * between its days) share a lane, in order, so its later days see what its earlier ones wrote.
 */
export function lanesOf<T extends { moment: Moment | null }[]>(calls: T[]) {
  const index = new Map(calls.map((c, i) => [c, i]));
  const laneOf = new Map<string, T[]>();
  const lanes = new Set<T[]>();
  for (const call of calls) {
    const ids = call.flatMap((g) => (g.moment ? [g.moment.id] : []));
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
 * offered again. Beyond those, the `person` facts of the last year about its people `close` to him: what is between
 * them lasts, and a newer fact must be able to replace it.
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
  const people = new Set(
    othersIn([
      ...group.units.flatMap((b) => b.unit.people),
      ...(group.moment?.people.map((p) => p.ref) ?? []),
    ])
  );
  const about = (o: Observation) =>
    o.date >= daysBefore(day, PRIOR_DAYS) &&
    (o.entities.some((e) => people.has(e)) ||
      (othersIn(o.entities).length === 0 && o.date >= daysBefore(day, 1)));
  const lasting = (o: Observation) =>
    o.type === "person" &&
    o.date >= daysBefore(day, BOND_DAYS) &&
    o.entities.some((e) => people.has(e) && close.has(e));
  const candidates = shown
    .filter(
      ({ by, o }) =>
        o.date <= day &&
        (o.madeBy.run === run || !reread.has(o.unit)) &&
        (!by || reread.has(by)) &&
        (about(o) || lasting(o))
    )
    .map(({ o }) => o)
    .toSorted((a, b) => b.at.localeCompare(a.at));
  const recent = candidates.filter(about).slice(0, max);
  const older = candidates
    .filter((o) => !recent.includes(o) && lasting(o))
    .slice(0, BOND_MAX);
  return [...recent, ...older];
}

/** Extracts the kept units of `evidence` (its window, `gather`) not read yet by this prompt. */
export async function extract(evidence: Evidence) {
  const step = await begin("extract", "deep", {
    prompt: EXTRACT_PROMPT,
    ...evidence.window,
  });
  const { now, today } = step;
  const { built, conversations, failed, truth } = evidence;
  // A source that could not be read counts as a failure: the night must not commit a partial day.
  step.stats.failed += failed.length;
  // Today is not over: its chats are still growing, so they wait for tomorrow; only closed lifelog conversations go now.
  const closed = closedConversations(conversations, now);
  const inWindow = built.filter(
    (b) =>
      b.unit.date < today ||
      (b.unit.source === "lifelog" && closed.has(b.unit.key))
  );
  const verdicts = await readVerdicts();
  const people = await readPeople();
  const { corrections, inferred, resolve } = people;
  const [written, { observations: known, standing }] = await Promise.all([
    readMoments(),
    observationsNow(people),
  ]);
  const { kept, pending, stale } = toExtract(
    inWindow,
    verdicts,
    rowsOf(EXTRACTED, Extracted),
    EXTRACT_PROMPT,
    rereadAt(corrections)
  );
  const unitOf = new Map(known.map((o) => [o.id, o.unit]));
  const shown = known.flatMap((o) => {
    const s = stateOf(o, standing);
    if (s.state === "retired") {
      // One he rated outdated (retired by itself) is closed for good.
      return s.by === o.id ? [] : [{ by: unitOf.get(s.by), o }];
    }
    return s.state === "active" ? [{ o }] : [];
  });
  const { copies, groups } = groupsOf(
    pending.map((p) => p.b),
    inWindow,
    verdicts,
    // A moment the owner said is wrong groups nothing.
    momentsNow(written, corrections)
  );

  const names = nameIndex(truth.people);
  const read = groups.flatMap((g) => g.units);
  const reread = new Set([...read, ...copies].map((b) => b.unit.id));
  const turns = await withStore(
    (store) =>
      new Map(
        read.flatMap(({ unit }) =>
          unit.source === "lifelog"
            ? [
                [
                  unit.id,
                  turnsBetween(
                    store,
                    unit.key,
                    unit.start,
                    unit.end,
                    lifelogNames(truth)
                  ),
                ] as const,
              ]
            : []
        )
      )
  );
  const jobs = await transcripts([...turns.values()].flat());
  let truncated = 0;
  const sourceOf = (b: Built): Source[] => {
    const all =
      b.unit.source === "lifelog"
        ? voiceLines(turns.get(b.unit.id) ?? [], jobs, names)
        : chatLines(b, resolve);
    // ponytail: a unit longer than UNIT_MAX keeps its first lines only (a longer line cut to it, as a whole note's text
    // can be); split the unit if long chapters matter.
    const shownLines = within(
      all.map((l) => ({ ...l, text: l.text.slice(0, UNIT_MAX) })),
      UNIT_MAX,
      (l) => l.text.length
    );
    truncated +=
      shownLines.length < all.length ||
      all.some((l) => l.text.length > UNIT_MAX)
        ? 1
        : 0;
    return shownLines.length > 0 ? [{ lines: shownLines, unit: b.unit }] : [];
  };
  const calls = packed(
    groups
      .flatMap((g) => byDays({ ...g, sources: g.units.flatMap(sourceOf) }))
      // In time order: a call sees the facts its lane's calls and the lanes before wrote (`lanesOf`).
      .toSorted((a, b) =>
        (a.units[0]?.unit.date ?? "").localeCompare(b.units[0]?.unit.date ?? "")
      )
  );
  const lanes = lanesOf(calls);

  const close = await closeNow();
  const context = refContext(truth, inferred, close);
  const candidates = new Set(
    [context.people, context.projects].flatMap((l) => l.map((x) => x.ref))
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
        moments: call.map(({ moment: m, sources: ss }) => ({
          id: m?.id ?? "none",
          people: m?.people ?? [],
          place: m?.place ?? null,
          start: m?.start ?? null,
          status: m?.status ?? null,
          title: m?.title ?? "units in no moment",
          units: ss.map(({ lines: ls, unit }) => ({
            id: unit.id,
            lines: ls.map(
              (l, n) => `[${n}] ${localTime(l.at)} ${who(l)}: ${l.text}`
            ),
            people: unit.people,
            source: unit.source,
            title: unit.title,
            triage: reasons.get(unit.id),
          })),
        })),
        prior: prior.map((o) => ({ date: o.date, id: o.id, text: o.text })),
      };
      const json = await step.ask({
        context,
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
  await inBatches(lanes, step.dir, async (lane, bdir) => {
    for (const [k, call] of lane.entries()) {
      // biome-ignore lint/performance/noAwaitInLoops: a lane's calls go in order, each seeing the facts of the last
      await one(call, k === 0 ? bdir : `${bdir}-${k}`);
    }
  });
  // Names lifelog gave a voice that the map doesn't know.
  for (const { unit } of finished) {
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
  const perUnit = new Map<string, number>();
  for (const o of observations) {
    perUnit.set(o.unit, (perUnit.get(o.unit) ?? 0) + 1);
  }
  await appendJsonl(
    EXTRACTED,
    Extracted,
    [...finished, ...copies].map(({ unit }) => ({
      at,
      observations: perUnit.get(unit.id) ?? 0,
      prompt: EXTRACT_PROMPT,
      run: step.run,
      schemaVersion: 1 as const,
      unit: unit.id,
      unitHash: unit.hash,
    }))
  );
  await appendJsonl(UNRESOLVED, Unresolved, unresolved);
  await Bun.write(
    join(step.dir, "rejects.jsonl"),
    rejects.map((r) => `${JSON.stringify(r)}\n`).join("")
  );
  return step.end({
    added: observations.length,
    cached: kept.length - pending.length,
    kept: kept.length,
    moments: groups.filter((g) => g.moment).length,
    read: finished.length,
    rejects: rejects.length,
    retired: retired.length,
    stale,
    truncated,
  });
}
