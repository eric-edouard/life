// `bun scripts/arrival-gate-count.ts --from <day> --to <day> [--store <folder>]`: the arrival gate's $0 proof
// (docs/operations.md, "Measuring"). It replays the sources' events in 2-minute steps, asks `arrivalsDue` at each, runs
// one pass at a time, and prints counts only: never a word, a name or a chat id. No model, writes nothing of his, holds
// no lock. `--store`: a folder holding a copy of the watcher's `lifelog.sqlite` (default: the state's own).

import { parseArgs } from "node:util";
import { DAY, daysBefore, MIN } from "@life/server/src/core/clock";
import {
  closestOf,
  EMBEDDER_URL,
  embedAll,
  embedderAt,
} from "@life/server/src/core/embedder";
import { CONVERSATION_ENDS_AFTER } from "@life/server/src/core/quiet";
import {
  ARRIVAL_AT_MOST,
  ARRIVAL_QUIET,
  type ArrivalReads,
  arrivalsDue,
  type GateAnswer,
  isArriving,
} from "@life/server/src/memory/arrival-gate";
import { readSourceEvents } from "@life/server/src/memory/gather";
import { ACTIONABLE, matterBookOf } from "@life/server/src/memory/matter-read";
import {
  mattersNow,
  readMatterRecords,
  readMatters,
} from "@life/server/src/memory/matters";
import {
  readFiles,
  readObservations,
  readUnitsOf,
  readVerdicts,
} from "@life/server/src/memory/memory-files";
import { showFiles } from "@life/server/src/memory/message-files";
import { kindOf, quietly } from "@life/server/src/memory/sources";
import { voiceUnitId } from "@life/server/src/memory/unit-ids";
import {
  applyRules,
  type Built,
  lifelogNames,
  lifelogUnits,
  type Resolve,
  sourceUnitsOf,
} from "@life/server/src/memory/units";
import { readPeople } from "@life/server/src/memory/who";
import { dayStart, localDate, time } from "@life/server/src/memory/zones";
import { CHARS_PER_TOKEN } from "@life/server/src/models/llm";
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
/** Flash's input price on its no-retention hosts: input-equivalent tokens to dollars (the plan's 3.5). */
const DOLLARS_PER_TOKEN = 0.078 / 1e6;
const TURN_TOKENS = 16;

interface Pass {
  at: number;
  day: string;
  /** The tokens of its units' own words, sent whole. */
  text: number;
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
      const id = voiceUnitId(c.id, localDate(t.at));
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

/** Today's units as the replay last built them, and every unit's lines by id: shared by every option. */
const building = () => ({
  built: [] as Built[],
  lastBuilt: new Map<string, Built[]>(),
  linesOf: new Map<string, string[]>(),
  signature: "",
});
type Build = ReturnType<typeof building>;

/** One way to run the passes: one at most every `every`, and layer 2's lines near an ask (absent: the layer is off). */
export interface Option {
  every: number;
  name: string;
  nearAnAsk?: ReadonlySet<string>;
}

/** An option's own state through the replay: its passes, when each line was read, the rule that last held the rest. */
const running = (o: Option, ownerNames: string[]) => ({
  heldBy: new Map<string, string>(),
  option: o,
  passEnd: 0,
  passes: [] as Pass[],
  readAt: new Map<string, number>(),
  reads: {
    // Card sends began on 18 Nov 2026: none in the days measured to keep a chat through.
    draftChats: new Set<string>(),
    lines: new Map<string, number>(),
    nearAnAsk: o.nearAnAsk,
    ownerNames,
  } satisfies ArrivalReads,
});
type Run = ReturnType<typeof running>;
type Replayed = Run & Pick<Build, "lastBuilt" | "linesOf">;

/** Today's units as of a tick, built again only when something arrived or a recording settled; their lines kept by unit. */
function rebuild(
  out: Build,
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

/** A unit's own words in tokens, as a pass sends them whole: a turn about 16, else its characters (the plan's 3.0). */
const textTokensOf = (u: Built["unit"]) =>
  kindOf(u.source) === "voice"
    ? u.stats.items * TURN_TOKENS
    : u.stats.chars / CHARS_PER_TOKEN;

/** The gate's word at `t`: each held unit's unread lines remember the rule; a pass starts on what is due when none runs. */
function tick(
  run: Run,
  linesOf: Build["linesOf"],
  arrivals: GateAnswer[],
  { day, t }: { day: string; t: number }
) {
  const unreadOf = (id: string) =>
    (linesOf.get(id) ?? []).slice(run.reads.lines.get(id) ?? 0);
  for (const a of arrivals) {
    if ("wait" in a) {
      for (const id of unreadOf(a.unit.id)) {
        run.heldBy.set(id, a.wait);
      }
    }
  }
  const due = arrivals.flatMap((a) => ("wait" in a ? [] : [a.unit]));
  if (t < run.passEnd || due.length === 0) {
    return;
  }
  for (const unit of due) {
    for (const id of unreadOf(unit.id)) {
      run.readAt.set(id, t);
    }
    run.reads.lines.set(unit.id, unit.stats.items);
  }
  run.passes.push({
    at: t,
    day,
    text: due.reduce((n, u) => n + textTokensOf(u), 0),
    units: due.map((u) => u.id),
  });
  run.passEnd = t + Math.max(PASS, run.option.every);
}

/**
 * The day passes the gate would have run from `start` to `end`, for each option: every `STEP` it builds today's units
 * from what had arrived (once for all options), asks `arrivalsDue`, and when no pass runs starts one on what is due.
 * Returns, per option, the passes, when each line was read, the rule that last held each line not read, and each
 * day's last units with their lines.
 */
export function replay(
  input: {
    end: number;
    events: SourceEvent[];
    ownerNames: string[];
    resolve: Resolve;
    start: number;
    talks: LifelogConversation[];
  },
  options: Option[] = [{ every: PASS, name: "gate" }]
): Replayed[] {
  const eventsOn = Map.groupBy(input.events, (e) => localDate(e.at));
  const talksOn = new Map<string, LifelogConversation[]>();
  for (const c of input.talks) {
    for (const day of new Set(c.turns.map((x) => localDate(x.at)))) {
      talksOn.set(day, [...(talksOn.get(day) ?? []), c]);
    }
  }
  const build = building();
  const runs = options.map((o) => running(o, input.ownerNames));
  for (let t = input.start; t < input.end; t += STEP) {
    const day = localDate(new Date(t).toISOString());
    const arrived = arrivedBy(
      t,
      eventsOn.get(day) ?? [],
      talksOn.get(day) ?? []
    );
    rebuild(build, day, arrived, input.resolve);
    for (const run of runs) {
      const arrivals = arrivalsDue(
        { built: build.built, conversations: arrived.voice },
        run.reads,
        new Date(t)
      );
      tick(run, build.linesOf, arrivals, { day, t });
    }
  }
  return runs.map((run) => ({
    ...run,
    lastBuilt: build.lastBuilt,
    linesOf: build.linesOf,
  }));
}

/** Nothing when a day pass read the line, else the rule that last held it. */
const fateOf = (r: Replayed, line: string) =>
  r.readAt.has(line) ? undefined : (r.heldBy.get(line) ?? "day-ended");

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
    // A pass's words are read twice (episodes, extract): small beside its fixed part, which is the cost.
    tokens += TOKENS[k] + 2 * (list[i]?.text ?? 0);
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
    tokens,
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

/** The share of `sorted` at or below which `share` of it lies. */
const centile = (sorted: number[], share: number) =>
  sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;

/**
 * Minutes from an ask's arrival (its line; a recording's end) to its card: the pass that read it starts, then runs
 * `PASS`. The median and the 90th centile, over the asks a day pass read.
 */
export function latencyOf(
  r: Replayed,
  truth: Truth,
  doneAt: Map<string, number>
) {
  const minutes = truth.asks
    .flatMap((a) => {
      const read = r.readAt.get(a.ref);
      const done = doneAt.get(a.ref);
      return read !== undefined && done !== undefined
        ? [(read + PASS - done) / MIN]
        : [];
    })
    .toSorted((a, b) => a - b);
  return {
    median: Math.round(centile(minutes, 0.5)),
    p90: Math.round(centile(minutes, 0.9)),
  };
}

/** One option in a row: passes a day, recall, dollars a day, the limit's days and earliest hour, latency; over `days`. */
export function summaryOf(
  r: Replayed,
  truth: Truth,
  days: string[],
  doneAt: Map<string, number>
) {
  const each = days.map((day) => passesOn(day, r, truth));
  const passes = each.map((d) => d.passes).toSorted((a, b) => a - b);
  const dollars = each
    .map((d) => d.tokens * DOLLARS_PER_TOKEN)
    .toSorted((a, b) => a - b);
  const hit = each
    .map((d) => d.limitAt)
    .filter((h) => h !== "not reached")
    .toSorted();
  const read = truth.asks.filter((a) => r.readAt.has(a.ref)).length;
  const latency = latencyOf(r, truth, doneAt);
  return {
    dollarsMedian: Number(centile(dollars, 0.5).toFixed(2)),
    dollarsWorst: Number((dollars.at(-1) ?? 0).toFixed(2)),
    latencyMedian: latency.median,
    latencyP90: latency.p90,
    limitDays: hit.length,
    limitEarliest: hit[0] ?? "-",
    option: r.option.name,
    passesMedian: centile(passes, 0.5),
    passesWorst: passes.at(-1) ?? 0,
    recall: `${read}/${truth.asks.length}`,
  };
}

/**
 * What an ask, a promise, a wait or an answer to one looks like, in the languages he writes (layer 2's examples,
 * made up). ponytail: kept here while layer 2 is measured; it moves to `prompts/ask-examples.txt` if PR 4b builds it.
 */
const ASK_EXAMPLES = [
  "Can you send me the file before Friday?",
  "Could you call me back when you have a minute?",
  "Please remind me to book the tickets tomorrow.",
  "I'll send it to you tonight, promise.",
  "I will pay you back next week.",
  "Let me check and get back to you.",
  "Waiting for your answer on the contract.",
  "Did you get a chance to look at my message?",
  "When can you come to fix it?",
  "Can we meet on Tuesday at 3?",
  "Done, I sent the transfer.",
  "Yes, I can do that for you.",
  "Tu peux m'envoyer le document avant vendredi ?",
  "Je te l'envoie ce soir, promis.",
  "Je te rappelle demain matin.",
  "N'oublie pas de réserver la table.",
  "J'attends ta réponse pour le devis.",
  "On peut se voir mardi à 15h ?",
  "C'est fait, je t'ai fait le virement.",
  "Tu as pu regarder mon message ?",
  "ส่งไฟล์ให้หน่อยได้ไหม",
  "เดี๋ยวพรุ่งนี้โทรกลับนะ",
  "รอคำตอบอยู่นะครับ",
  "โอนเงินให้แล้วนะ",
];
/** The open matters' texts shown for a line: their to-dos, promises and waits from the 45 days before its day. */
const MATTER_DAYS = 45;

/** Texts as queries, a batch at a time (the embedder runs one at a time anyway). */
async function queryVectors(texts: string[]) {
  const embedder = embedderAt(EMBEDDER_URL);
  const vectors: number[][] = [];
  for (let i = 0; i < texts.length; i += 32) {
    // biome-ignore lint/performance/noAwaitInLoops: one batch at a time
    vectors.push(...(await embedder.embed(texts.slice(i, i + 32), "query")));
  }
  return vectors;
}

/**
 * Layer 2's scores, by the Mac's embedder (nothing leaves the Mac): for each chat and mail line, how close it is to the
 * ask examples, and to the open matters' steps of the 45 days before its day that had not ended by then (never a later
 * step: those were read from these very lines).
 */
async function readNearness(
  events: SourceEvent[],
  steps: { day: string; endedAt?: string; text: string }[]
) {
  const lines = events.filter(
    (e) => isArriving(e.source) && kindOf(e.source) !== "voice" && e.text
  );
  const vectors = await embedAll(
    embedderAt(EMBEDDER_URL),
    lines.map((e) => e.text)
  );
  const examples = await queryVectors(ASK_EXAMPLES);
  const stepVectors = await queryVectors(steps.map((x) => x.text));
  const scores = new Map<string, { asks: number; matters: number }>();
  for (const [i, e] of lines.entries()) {
    const day = localDate(e.at);
    const open = stepVectors.filter((_, j) => {
      const x = steps[j];
      return (
        x !== undefined &&
        x.day < day &&
        x.day >= daysBefore(day, MATTER_DAYS) &&
        !(x.endedAt && x.endedAt < e.at)
      );
    });
    const v = vectors[i] ?? [];
    scores.set(e.id, {
      asks: closestOf(examples, v),
      matters: closestOf(open, v),
    });
  }
  return scores;
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
  const book = matterBookOf(
    mattersNow(readMatters()),
    await readMatterRecords(people),
    to
  );
  const steps = book.flatMap((v) =>
    v.steps
      .filter((x) => ACTIONABLE.includes(x.kind))
      .map((x) => ({ day: x.day, endedAt: x.ending?.at, text: x.text }))
  );
  // A day's night has run when one of its units has a verdict that kept it.
  const nightDays = days.filter((d) =>
    readUnitsOf([d]).some((u) => kept.has(u.id))
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
    nightDays,
    steps,
    truth: { asks: [...asks.values()], kept },
  };
}

/** Layer 2's thresholds tried, and the minutes between passes. */
const THRESHOLDS = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6];
const CADENCES = [10, 20, 30];

/** Every option measured: the gate alone and with layer 2 at each threshold (examples and matters, or matters only), at each cadence. */
function optionsOf(near: Map<string, { asks: number; matters: number }>) {
  const above = (
    at: number,
    score: (x: { asks: number; matters: number }) => number
  ) => new Set([...near].filter(([, x]) => score(x) >= at).map(([id]) => id));
  return CADENCES.flatMap((minutes): Option[] => [
    { every: minutes * MIN, name: `gate, every ${minutes}` },
    ...THRESHOLDS.flatMap((at) => [
      {
        every: minutes * MIN,
        name: `near ${at}, every ${minutes}`,
        nearAnAsk: above(at, (x) => Math.max(x.asks, x.matters)),
      },
      {
        every: minutes * MIN,
        name: `near matters ${at}, every ${minutes}`,
        nearAnAsk: above(at, (x) => x.matters),
      },
    ]),
  ]);
}

/** The tables of one option: by day, by day and source, held by rule, the asks' fates. */
function printDetails(
  r: Replayed,
  truth: Truth,
  days: string[],
  atOf: Map<string, number>
) {
  const { held, rows } = arrivalsOf(r, atOf);
  const total = (day: string, key: "arrivals" | "passed") =>
    [...rows]
      .filter(([k]) => k.startsWith(day))
      .reduce((n, [, x]) => n + x[key], 0);
  console.log(`Details: ${r.option.name}`);
  console.table(
    days.map((day) => {
      const { tokens: _, ...shown } = passesOn(day, r, truth);
      return {
        arrivals: total(day, "arrivals"),
        day,
        passed: total(day, "passed"),
        ...shown,
      };
    })
  );
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
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      from: { type: "string" },
      show: { type: "string" },
      store: { type: "string" },
      to: { type: "string" },
    },
  });
  const { from, to } = values;
  if (!(from && to)) {
    throw new Error("--from and --to are required");
  }
  const { days, failed, input, nightDays, steps, truth } =
    await readReplayInput(from, to, values.store);
  const near = await readNearness(input.events, steps);
  const runs = replay(input, optionsOf(near));
  const atOf = new Map<string, number>([
    ...input.events.map((e): [string, number] => [e.id, Date.parse(e.at)]),
    ...input.talks.flatMap((c) =>
      c.turns.map((x): [string, number] => [
        turnRef(x.jobId, x.turnIndex, x.at),
        Date.parse(x.at),
      ])
    ),
  ]);
  // A card can follow a recording only once it ended: its asks' latency counts from there.
  const doneAt = new Map<string, number>([
    ...atOf,
    ...input.talks.flatMap((c) =>
      c.turns.map((x): [string, number] => [
        turnRef(x.jobId, x.turnIndex, x.at),
        Date.parse(c.endedAt),
      ])
    ),
  ]);
  console.log(
    `Arrival gate, ${from} to ${to}: counts only. Dollars, limit and latency over the ${nightDays.length} days whose night ran.`
  );
  console.table(runs.map((r) => summaryOf(r, truth, nightDays, doneAt)));
  const shown = runs.find(
    (r) => r.option.name === (values.show ?? "gate, every 10")
  );
  if (shown) {
    printDetails(shown, truth, days, atOf);
  }
  console.log(
    failed.length > 0
      ? `Not read, so missing above: ${failed.join(", ")}`
      : "Every source was read."
  );
}
