// `bun scripts/arrival-gate-count.ts --from <day> --to <day> [--store <folder>]`: the arrival gate's $0 proof
// (docs/operations.md, "Measuring"). It replays the sources' events in 2-minute steps, asks `arrivalsDue` at each, runs
// one pass at a time, and prints counts only: never a word, a name or a chat id. No model, writes nothing of his, holds
// no lock. `--store`: a folder holding a copy of the watcher's `lifelog.sqlite` (default: the state's own).

import { parseArgs } from "node:util";
import { DAY, daysBefore, MIN } from "@life/server/src/core/clock";
import { CONVERSATION_ENDS_AFTER } from "@life/server/src/core/quiet";
import {
  ARRIVAL_AT_MOST,
  ARRIVAL_QUIET,
  type Arrival,
  type ArrivalReads,
  arrivalsDue,
  isArriving,
} from "@life/server/src/memory/arrival-gate";
import {
  readFiles,
  readObservations,
  readUnitsOf,
  readVerdicts,
} from "@life/server/src/memory/memory-files";
import { showFiles } from "@life/server/src/memory/message-files";
import { kindOf, quietly } from "@life/server/src/memory/sources";
import {
  applyRules,
  type Built,
  lifelogNames,
  lifelogUnits,
  type Resolve,
  readSourceEvents,
  sourceUnitsOf,
  unitId,
} from "@life/server/src/memory/units";
import { readPeople } from "@life/server/src/memory/who";
import { dayStart, localDate, time } from "@life/server/src/memory/zones";
import type { SourceEvent } from "@life/server/src/records/source";
import { ownerIn } from "@life/server/src/records/truth";
import { KEEP_AT } from "@life/server/src/records/unit";
import {
  type LifelogConversation,
  readConversations,
  readStore,
  turnRef,
} from "@life/server/src/sources/lifelog";

/** A tick of the replay, and how long a pass holds the next one off (the plan's 8–12 minutes). */
const STEP = 2 * MIN;
const PASS = 10 * MIN;
/** Input-equivalent tokens (in + 3 × out) of a pass by how far it goes, and the day's limit (the plan's 3.2, 3.5). */
const TOKENS = { full: 255_000, light: 120_000, triage: 57_000 };
const DAY_LIMIT = 6_400_000;

interface Pass {
  at: number;
  day: string;
  units: string[];
}

/** What the night found in these days, as stored: the units it kept, and its asks (promises, waits, to-dos) by line. */
export interface Truth {
  asks: { channel: string; ref: string; unit: string }[];
  kept: Set<string>;
}

/** The turn refs of each recording's unit, in order: a voice unit's lines. */
function turnLinesOf(talks: LifelogConversation[]) {
  const lines = new Map<string, string[]>();
  for (const c of talks) {
    for (const t of c.turns) {
      const id = unitId("lifelog", c.id, localDate(t.at));
      lines.set(id, [
        ...(lines.get(id) ?? []),
        turnRef(t.jobId, t.turnIndex, t.at),
      ]);
    }
  }
  return lines;
}

/** Bursts of a unit's lines: a new one after `ARRIVAL_QUIET` of quiet, or `ARRIVAL_AT_MOST` after the burst began. */
export function burstsOf(lines: { at: number; id: string }[]) {
  const bursts: { at: number; id: string }[][] = [];
  for (const line of lines) {
    const last = bursts.at(-1);
    const first = last?.[0];
    const prev = last?.at(-1);
    if (
      last &&
      first &&
      prev &&
      line.at - prev.at < ARRIVAL_QUIET &&
      line.at - first.at < ARRIVAL_AT_MOST
    ) {
      last.push(line);
    } else {
      bursts.push([line]);
    }
  }
  return bursts;
}

/** Today's events and recordings as of `t`: a recording is settled `CONVERSATION_ENDS_AFTER` after it ended. */
function arrivedBy(
  t: number,
  events: SourceEvent[],
  talks: LifelogConversation[]
) {
  const iso = new Date(t).toISOString();
  return {
    today: events.filter((e) => e.at <= iso),
    voice: talks
      .filter((c) => c.startedAt <= iso)
      .map((c) => ({
        ...c,
        closed: t >= Date.parse(c.endedAt) + CONVERSATION_ENDS_AFTER,
        turns: c.turns.filter((x) => x.at <= iso),
      })),
  };
}

type Replayed = ReturnType<typeof replayed>;
const replayed = () => ({
  built: [] as Built[],
  heldBy: new Map<string, string>(),
  lastBuilt: new Map<string, Built[]>(),
  linesOf: new Map<string, string[]>(),
  passEnd: 0,
  passes: [] as Pass[],
  readByDay: new Set<string>(),
  // Card sends began on 18 Nov 2026: none in the days measured to keep a chat through.
  reads: { draftChats: new Set(), lines: new Map() } as Omit<
    ArrivalReads,
    "ownerNames"
  >,
  signature: "",
});

/** Today's units as of a tick, built again only when something arrived or a recording settled; their lines kept by unit. */
function rebuild(
  out: Replayed,
  day: string,
  { today, voice }: ReturnType<typeof arrivedBy>,
  resolve: Resolve
) {
  const signature = `${day} ${today.length} ${voice.map((c) => `${c.turns.length}${c.closed}`).join()}`;
  if (signature === out.signature) {
    return;
  }
  out.signature = signature;
  out.built = [
    ...applyRules(lifelogUnits(voice, new Set())),
    ...sourceUnitsOf(today, resolve),
  ].filter((b) => b.unit.date === day);
  for (const [id, refs] of turnLinesOf(voice)) {
    out.linesOf.set(id, refs);
  }
  for (const b of out.built.filter((x) => x.messages.length > 0)) {
    out.linesOf.set(
      b.unit.id,
      b.messages.map((m) => m.id)
    );
  }
  out.lastBuilt.set(day, out.built);
}

/** The gate's word at `t`: each held unit's unread lines remember the rule; a pass starts on what is due when none runs. */
function tick(out: Replayed, arrivals: Arrival[], t: number, day: string) {
  const unreadOf = (id: string) =>
    (out.linesOf.get(id) ?? []).slice(out.reads.lines.get(id) ?? 0);
  for (const a of arrivals) {
    if ("wait" in a) {
      for (const id of unreadOf(a.unit.id)) {
        out.heldBy.set(id, a.wait);
      }
    }
  }
  const due = arrivals.flatMap((a) => ("wait" in a ? [] : [a.unit]));
  if (t < out.passEnd || due.length === 0) {
    return;
  }
  for (const unit of due) {
    for (const id of unreadOf(unit.id)) {
      out.readByDay.add(id);
    }
    out.reads.lines.set(unit.id, unit.stats.items);
  }
  out.passes.push({ at: t, day, units: due.map((u) => u.id) });
  out.passEnd = t + PASS;
}

/**
 * The day passes the gate would have run from `start` to `end`: every `STEP` it builds today's units from what had
 * arrived, asks `arrivalsDue`, and when no pass runs starts one on what is due. Returns the passes, the lines a pass
 * read, the rule that last held each line not read, and each day's last units with their lines.
 */
export function replay(input: {
  end: number;
  events: SourceEvent[];
  ownerNames: string[];
  resolve: Resolve;
  start: number;
  talks: LifelogConversation[];
}) {
  const eventsOn = Map.groupBy(input.events, (e) => localDate(e.at));
  const talksOn = new Map<string, LifelogConversation[]>();
  for (const c of input.talks) {
    for (const day of new Set(c.turns.map((x) => localDate(x.at)))) {
      talksOn.set(day, [...(talksOn.get(day) ?? []), c]);
    }
  }
  const out = replayed();
  const reads = { ...out.reads, ownerNames: input.ownerNames };
  for (let t = input.start; t < input.end; t += STEP) {
    const day = localDate(new Date(t).toISOString());
    const arrived = arrivedBy(
      t,
      eventsOn.get(day) ?? [],
      talksOn.get(day) ?? []
    );
    rebuild(out, day, arrived, input.resolve);
    const arrivals = arrivalsDue(
      { built: out.built, conversations: arrived.voice },
      reads,
      new Date(t)
    );
    tick(out, arrivals, t, day);
  }
  return out;
}

/** Nothing when a day pass read the line, else the rule that last held it. */
const fateOf = (r: Replayed, line: string) =>
  r.readByDay.has(line) ? undefined : (r.heldBy.get(line) ?? "day-ended");

interface Row {
  arrivals: number;
  passed: number;
  passes: Set<number>;
}

/** Every arrival (a burst of a unit's lines; a recording's day is one): its row (day and source), its unit, and the rule that held it, none when a day pass read it. */
const arrivalListOf = (r: Replayed, atOf: Map<string, number>) =>
  [...r.lastBuilt].flatMap(([day, units]) =>
    units
      .filter((b) => isArriving(b.unit.source))
      .flatMap(({ unit }) => {
        const lines = (r.linesOf.get(unit.id) ?? []).map((id) => ({
          at: atOf.get(id) ?? 0,
          id,
        }));
        const bursts =
          kindOf(unit.source) === "voice" ? [lines] : burstsOf(lines);
        return bursts
          .filter((b) => b.length > 0)
          .map((burst) => ({
            key: `${day} ${unit.source}`,
            rule: fateOf(r, burst.at(-1)?.id ?? ""),
            unit: unit.id,
          }));
      })
  );

/** Each day and source's arrivals, how many a pass read, the passes they were in; and by rule, the arrivals held. */
export function arrivalsOf(r: Replayed, atOf: Map<string, number>) {
  const list = arrivalListOf(r, atOf);
  const rowOfUnit = new Map(list.map((a) => [a.unit, a.key]));
  const rows = new Map<string, Row>();
  for (const a of list) {
    const row = rows.get(a.key) ?? {
      arrivals: 0,
      passed: 0,
      passes: new Set(),
    };
    rows.set(a.key, row);
    row.arrivals += 1;
    row.passed += a.rule ? 0 : 1;
  }
  for (const [i, p] of r.passes.entries()) {
    for (const id of p.units) {
      rows.get(rowOfUnit.get(id) ?? "")?.passes.add(i);
    }
  }
  const held = new Map(
    [
      ...Map.groupBy(
        list.filter((a) => a.rule),
        (a) => a.rule as string
      ),
    ].map(([rule, l]) => [rule, l.length])
  );
  return { held, rows };
}

/** A day's passes by how far each would have gone (from what the night found), their tokens, and when the limit binds. */
export function passesOn(day: string, r: Replayed, truth: Truth) {
  const asked = new Set(truth.asks.map((a) => a.unit));
  const list = r.passes.filter((p) => p.day === day);
  const kinds = list.map((p): keyof typeof TOKENS => {
    if (p.units.some((u) => asked.has(u))) {
      return "full";
    }
    return p.units.some((u) => truth.kept.has(u)) ? "light" : "triage";
  });
  let tokens = 0;
  let limitAt = "not reached";
  for (const [i, k] of kinds.entries()) {
    tokens += TOKENS[k];
    if (tokens >= DAY_LIMIT && limitAt === "not reached") {
      limitAt = time(new Date(list[i]?.at ?? 0).toISOString());
    }
  }
  const count = (k: string) => kinds.filter((x) => x === k).length;
  return {
    full: count("full"),
    light: count("light"),
    limitAt,
    passes: list.length,
    tokensM: Number((tokens / 1e6).toFixed(2)),
    triage: count("triage"),
  };
}

/** The night's asks by channel: read by a day pass, missed (with the rule that held its line), or not a line replayed. */
export function missesOf(r: Replayed, truth: Truth, atOf: Map<string, number>) {
  const misses = new Map<string, number>();
  for (const a of truth.asks) {
    const rule = fateOf(r, a.ref);
    let fate = rule ? `missed: ${rule}` : "read by day";
    if (rule && !atOf.has(a.ref)) {
      fate = "not in the replay";
    }
    const key = `${a.channel} ${fate}`;
    misses.set(key, (misses.get(key) ?? 0) + 1);
  }
  return misses;
}

/** His sources and what the night found over `from`..`to`, read-only. */
async function readReplayInput(from: string, to: string, store?: string) {
  const start = dayStart(from).getTime();
  const end = dayStart(daysBefore(to, -1)).getTime();
  const days = Array.from({ length: Math.round((end - start) / DAY) }, (_, i) =>
    daysBefore(from, -i)
  );
  const people = await readPeople();
  const { failed, read } = await readSourceEvents(
    new Date(start),
    new Date(end),
    people.truth,
    quietly
  );
  const events = showFiles(
    read.flatMap((x) => x.events),
    readFiles()
  ).toSorted((a, b) => a.at.localeCompare(b.at));
  const watcher = readStore(store);
  const talks = readConversations(
    watcher,
    new Date(start),
    lifelogNames(people.truth)
  );
  watcher.db.close();
  const owner = ownerIn(people.truth.people);
  const inWindow = new Set(readUnitsOf(days).map((u) => u.id));
  // A fact read again gets a new id: one ask per kind and line.
  const asks = new Map(
    (await readObservations())
      .filter(
        (o) =>
          ["promise", "to_do", "waiting_on_someone"].includes(o.type) &&
          inWindow.has(o.unit)
      )
      .map((o) => [
        `${o.type} ${o.source.ref}`,
        { channel: o.source.channel, ref: o.source.ref, unit: o.unit },
      ])
  );
  const kept = new Set(
    [...readVerdicts().values()]
      .filter((v) => v.importance >= KEEP_AT)
      .map((v) => v.unit)
  );
  return {
    days,
    failed,
    input: {
      end,
      events,
      ownerNames: [
        owner.name,
        owner.name.split(" ")[0] ?? "",
        ...owner.aliases,
      ],
      resolve: people.resolve,
      start,
      talks,
    },
    truth: { asks: [...asks.values()], kept },
  };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      store: { type: "string" },
      to: { type: "string" },
    },
  });
  const from = values.from ?? "2026-11-05";
  const to = values.to ?? "2026-11-18";
  const { days, failed, input, truth } = await readReplayInput(
    from,
    to,
    values.store
  );
  const r = replay(input);
  const atOf = new Map<string, number>([
    ...input.events.map((e): [string, number] => [e.id, Date.parse(e.at)]),
    ...input.talks.flatMap((c) =>
      c.turns.map((x): [string, number] => [
        turnRef(x.jobId, x.turnIndex, x.at),
        Date.parse(x.at),
      ])
    ),
  ]);
  const { held, rows } = arrivalsOf(r, atOf);
  const total = (day: string, key: "arrivals" | "passed") =>
    [...rows]
      .filter(([k]) => k.startsWith(day))
      .reduce((n, [, x]) => n + x[key], 0);
  const byDay = days.map((day) => ({
    arrivals: total(day, "arrivals"),
    day,
    passed: total(day, "passed"),
    ...passesOn(day, r, truth),
  }));
  const sorted = byDay.map((d) => d.passes).toSorted((a, b) => a - b);
  console.log(`Arrival gate, ${from} to ${to}: counts only.`);
  console.table(byDay);
  console.table(
    [...rows].map(([key, x]) => ({
      arrivals: x.arrivals,
      key,
      passed: x.passed,
      passes: x.passes.size,
    }))
  );
  console.table(Object.fromEntries([...held].toSorted((a, b) => b[1] - a[1])));
  console.table(Object.fromEntries([...missesOf(r, truth, atOf)].toSorted()));
  console.log(
    `Passes a day: median ${sorted[Math.floor(sorted.length / 2)]}, worst ${sorted.at(-1)}.`
  );
  console.log(
    failed.length > 0
      ? `Not read, so missing above: ${failed.join(", ")}`
      : "Every source was read."
  );
}
