// `bun scripts/memory-pilot.ts <read> <person>… [--run] [--engine <engine>] [--last <n>] [--sample <n>] | --all`: the memory
// rework's pilot (docs/operations.md, "Measuring"). For each person named, their one-to-one chats both sides wrote in,
// a batch of exchanges per call; `--last` keeps each person's newest batches only (the second family's check);
// `--sample` reads about that many exchanges of everyone else instead, the people named left out. Without `--run` it
// only counts what it would ask. Prints counts, never a word or a name.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { readJson, writeJson } from "@life/server/src/core/files";
import { digest } from "@life/server/src/core/hash";
import { Engine } from "@life/server/src/core/names";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import {
  directChats,
  directOf,
  readWithPeople,
} from "@life/server/src/memory/closeness";
import { batchesOf, isLiving } from "@life/server/src/memory/exchanges";
import { folded, locate } from "@life/server/src/memory/observe";
import {
  begin,
  checkedEntries,
  inputsOf,
  type Step,
} from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
import { textOf } from "@life/server/src/memory/units";
import { type People, readPeople } from "@life/server/src/memory/who";
import { batchLines } from "@life/server/src/memory/words";
import {
  askOnce,
  CHARS_PER_TOKEN,
  llmFor,
  llmSpec,
  promptText,
  stamp,
} from "@life/server/src/models/llm";
import { chatGroups, type SourceEvent } from "@life/server/src/records/source";
import { z } from "zod";

/** Where a reply is kept, by read and engine: his data, outside `memory/`, so no lock and no nightly step reads it. */
export const KEPT = join(OWNER_DATA_DIR, "docs", "memory-rework", "pilot");

/**
 * A test set: batches of exchanges saved whole, each with whom it is, so a wording is tried and two readers are
 * compared without reading his sources again (`pilot-set.ts` writes one, `--set <name>` reads it).
 */
export type TestSet = { batch: SourceEvent[][]; with: With }[];
export const setFile = (name: string) => join(KEPT, "sets", `${name}.json`);
export const readSet = (name: string) => {
  const set = readJson<TestSet>(setFile(name));
  if (!set) {
    throw new Error(`no test set ${name}: bun scripts/pilot-set.ts first`);
  }
  return set;
};

const RESOURCES = [
  "affection",
  "standing",
  "information",
  "money",
  "goods",
  "service",
] as const;
const cited = { line: z.int().min(0), quote: z.string() };
const opening = {
  ...cited,
  answer: z
    .object({
      kind: z.enum(["toward", "away", "against"]),
      line: z.int().min(0),
    })
    .nullish(),
};
/** A move of the connection read, by its code: what each carries beside its line and its quote. */
const ConnectionMove = z.discriminatedUnion("code", [
  z.object({
    code: z.enum([
      "shares",
      "good_news",
      "support_asked",
      "invites",
      "reassurance_asked",
    ]),
    ...opening,
  }),
  z.object({
    code: z.literal("discloses"),
    depth: z.int().min(1).max(3),
    ...opening,
  }),
  z.object({
    code: z.enum(["asks_for", "offers"]),
    resource: z.enum(RESOURCES),
    ...opening,
  }),
  z.object({
    code: z.enum(["gives", "refuses", "returns"]),
    resource: z.enum(RESOURCES),
    ...cited,
  }),
  z.object({
    code: z.enum([
      "asks_about",
      "thanks",
      "affection",
      "support_given",
      "explores",
    ]),
    ...cited,
  }),
]);
/** A move of the mentions read: someone not in the conversation talked about, or what a writer says of their own mind. */
const MentionsMove = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("mention"),
    kind: z.enum(["fact", "judgement"]),
    purpose: z.enum([
      "informs",
      "plans",
      "complains",
      "praises",
      "worries",
      "asks_advice",
      "jokes",
    ]),
    reported: z.boolean(),
    scope: z.enum(["act", "person"]),
    tone: z.enum(["positive", "neutral", "negative"]),
    who: z.string().min(1).max(80),
    ...cited,
  }),
  z.object({
    code: z.literal("feels"),
    valence: z.enum(["positive", "negative"]),
    ...cited,
  }),
  z.object({ code: z.enum(["intends", "wants", "believes"]), ...cited }),
]);
const Strength = z.int().min(1).max(3);
/** A move of the conflict read: friction, the answer to a fault (`to`: the line it answers), and who steers. */
const ConflictMove = z.discriminatedUnion("code", [
  z.object({
    code: z.enum(["fault", "contempt", "presses"]),
    strength: Strength,
    ...cited,
  }),
  z.object({
    code: z.literal("blames"),
    on: z.enum(["other", "self", "third", "circumstances"]),
    ...cited,
  }),
  z.object({
    code: z.literal("apologises"),
    parts: z.array(z.enum(["admits", "regret", "repair"])).default([]),
    to: z.int().min(0).nullish(),
    ...cited,
  }),
  z.object({
    code: z.enum([
      "engages",
      "excuses",
      "denies",
      "counters",
      "yields",
      "moves_on",
    ]),
    to: z.int().min(0).nullish(),
    ...cited,
  }),
  z.object({
    code: z.enum(["distress", "directs", "proposes", "defers", "decides"]),
    ...cited,
  }),
]);
/** A move of any read, as code checks it: its code, its line, its words. */
interface Move {
  code: string;
  line: number;
  quote: string;
}
/** The reads the pilot knows: the prompt of each, the shape of its moves, and what makes two moves of one person one. */
export const READS = {
  conflict: {
    move: ConflictMove,
    prompt: "memory-conflict.v2",
    voteOf: (m: Move) => m.code,
  },
  connection: {
    move: ConnectionMove,
    prompt: "memory-connection.v3",
    voteOf: (m: Move) => m.code,
  },
  mentions: {
    move: MentionsMove,
    prompt: "memory-mentions.v1",
    // A mention is one per person talked about.
    voteOf: (m: Move) =>
      "who" in m ? `${m.code}|${folded(String(m.who)).out}` : m.code,
  },
} satisfies Record<string, Read>;
interface Read {
  move: z.ZodType<Move>;
  prompt: string;
  voteOf: (m: Move) => string;
}
export type ReadName = keyof typeof READS;
const Tone = z.enum(["warm", "neutral", "cold"]).nullish().catch(undefined);
/** One exchange of a reply; its moves are checked one by one (`movesOf`). Each read fills the flags it is asked for. */
const ExchangeEntry = z.object({
  conflict: z.boolean().optional(),
  exchange: z.int().min(0),
  moves: z.array(z.unknown()),
  tension: z.boolean().optional(),
  // A tone that is none of the three is no tone: it never costs the exchange its moves.
  tone: z.object({ me: Tone, them: Tone }).catch({}),
});
/** What makes a reply one, and so worth keeping: an object with its exchanges. The rest is checked when read. */
const Reply = z.object({ exchanges: z.array(z.unknown()) });

/** An exchange of a batch: its messages, from line `start` of the batch. */
interface Span {
  end: number;
  messages: SourceEvent[];
  start: number;
}

/**
 * The words of a move and the line they are on, inside its exchange: the quote found there (`locate`, the cited line
 * first), else, for a quote too short for `locate`, the cited line whole when the quote is in it.
 */
function quoted(m: Move, span: Span) {
  const texts = span.messages.map(textOf);
  const at = m.line - span.start;
  const found = locate(m.quote, texts, at);
  if (found) {
    return { line: span.start + found.line, verbatim: found.verbatim };
  }
  const whole = texts[at] ?? "";
  const quote = folded(m.quote).out.trim();
  return quote && folded(whole).out.includes(quote)
    ? { line: m.line, verbatim: whole }
    : null;
}

/** A move's answer, kept only when it is a later line of the same exchange, written by the other side. */
function answerOf(m: Move, line: number, by: SourceEvent, span: Span) {
  const answer =
    "answer" in m
      ? (m.answer as { kind: string; line: number } | null | undefined)
      : undefined;
  const reply = answer ? span.messages[answer.line - span.start] : undefined;
  const isTheirs = reply && !reply.phoneCall && reply.fromMe !== by.fromMe;
  return answer && isTheirs && answer.line > line ? answer : undefined;
}

/** The line a move answers (`to`), kept only when it is an earlier line of the same exchange, written by the other side. */
function answeredOf(m: Move, line: number, by: SourceEvent, span: Span) {
  const to = "to" in m && typeof m.to === "number" ? m.to : undefined;
  const said = to === undefined ? undefined : span.messages[to - span.start];
  return said && said.fromMe !== by.fromMe && (to as number) < line
    ? to
    : undefined;
}

/**
 * The moves of one exchange code accepts: a known code, on a line of the exchange that is not a call, its words found
 * there, one per code and person.
 */
function movesOf(raw: unknown[], span: Span, read: Read) {
  const { entries } = checkedEntries(
    raw,
    read.move,
    (m) => `${m.line}|${m.code}`,
    (key) => {
      const line = Number.parseInt(key, 10);
      return line >= span.start && line < span.end;
    }
  );
  const seen = new Set<string>();
  let offLine = 0;
  const moves = entries.flatMap((m) => {
    const found = quoted(m, span);
    const message = found ? span.messages[found.line - span.start] : undefined;
    const vote = `${message?.fromMe}|${read.voteOf(m)}`;
    if (!(found && message) || message.phoneCall || seen.has(vote)) {
      return [];
    }
    seen.add(vote);
    offLine += found.line === m.line ? 0 : 1;
    return [
      {
        ...m,
        answer: answerOf(m, found.line, message, span),
        at: message.at,
        by: message.fromMe ? "me" : "them",
        line: found.line,
        quote: found.verbatim,
        to: answeredOf(m, found.line, message, span),
      },
    ];
  });
  return { dropped: raw.length - moves.length, moves, offLine };
}

/**
 * A reply's moves as code accepts them, exchange by exchange. An exchange is one the batch really holds, named by its
 * first line (`starts`), once; a move stays inside its exchange; who made it and when come from the message, never
 * from the reply. Throws on a reply that is not one. `dropped`: moves refused; `offLine`: quotes found on another
 * line of their exchange; `missing`: exchanges of the batch the reply left out or got wrong.
 */
export function checkedMoves(
  reply: unknown,
  messages: SourceEvent[],
  starts: number[],
  name: ReadName = "connection"
) {
  const read: Read = READS[name];
  const spans = new Map(
    starts.map((start, i): [number, Span] => {
      const end = starts[i + 1] ?? messages.length;
      return [start, { end, messages: messages.slice(start, end), start }];
    })
  );
  const { entries } = checkedEntries(
    Reply.parse(reply).exchanges,
    ExchangeEntry,
    (x) => String(x.exchange),
    (key) => spans.has(Number(key))
  );
  const counts = {
    dropped: 0,
    missing: starts.length - entries.length,
    offLine: 0,
  };
  const exchanges = entries.map((x) => {
    const { dropped, moves, offLine } = movesOf(
      x.moves,
      spans.get(x.exchange) as Span,
      read
    );
    counts.dropped += dropped;
    counts.offLine += offLine;
    return {
      conflict: x.conflict,
      exchange: x.exchange,
      moves,
      tension: x.tension,
      tone: x.tone,
    };
  });
  return { ...counts, exchanges };
}

export interface With {
  name: string;
  relation: string | null;
}
/** One call: what the model is shown, the messages its lines are, and the key its reply is kept under. */
type Call = ReturnType<typeof callOf>;
function callOf(batch: SourceEvent[][], withWhom: With, wording: string) {
  const { lines, messages, starts } = batchLines(batch, (e) =>
    e.fromMe ? "me" : withWhom.name
  );
  const input = { lines, with: withWhom };
  return { input, key: inputsOf(wording, input), messages, starts };
}

/**
 * The calls for one person: a batch of exchanges each, over their one-to-one chats both sides wrote in. `wording` is
 * the prompt's text, so a reply is kept for the wording that made it: the pilot rewords between rounds.
 */
export const callsOf = (
  messages: SourceEvent[],
  withWhom: With,
  wording: string
) =>
  [...chatGroups(messages).values()]
    .filter(isLiving)
    .flatMap((chat) =>
      batchesOf(chat).map((batch) => callOf(batch, withWhom, wording))
    );

/** The calls whose reply is not kept yet, each once. */
const notKept = (calls: Call[], dir: string) => [
  ...new Map(
    calls
      .filter((c) => !existsSync(join(dir, `${c.key}.json`)))
      .map((c) => [c.key, c])
  ).values(),
];

/** What a pass over `calls` would ask and what is kept already; tokens at most, the prompt counted in every call. */
export function countsOf(calls: Call[], dir: string, wording: string) {
  const toAsk = notKept(calls, dir);
  const chars = toAsk.reduce(
    (n, c) => n + wording.length + JSON.stringify(c.input).length,
    0
  );
  return {
    batches: calls.length,
    keptAlready: calls.length - toAsk.length,
    toAsk: toAsk.length,
    tokensAtMost: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

/**
 * Makes every call not kept yet, a few at a time. A reply that is one (`Reply`) is kept as the model gave it, with
 * what made it, the wording's digest and the messages it read; its moves are worked out from it when read
 * (`checkedMoves`), never stored. A call that fails, or a reply that is not one, keeps nothing and is made again at
 * the next pass. `prompt` is the prompt's name, `wording` its text.
 */
export async function makeCalls(
  calls: Call[],
  step: Pick<Step, "ask" | "attempt" | "dir" | "llm" | "run">,
  prompt: string,
  wording: string,
  dir: string,
  name: ReadName = "connection",
  parallel = 4
) {
  const counts = { dropped: 0, missing: 0, moves: 0, offLine: 0 };
  const one = async (c: Call, bdir: string) => {
    await step.attempt(
      async () => {
        const reply = await step.ask({ dir: bdir, input: c.input, prompt });
        const checked = checkedMoves(reply, c.messages, c.starts, name);
        writeJson(join(dir, `${c.key}.json`), {
          madeBy: stamp(step.llm, prompt, step.run),
          messages: c.messages.map((m) => `${m.source}|${m.id}`),
          reply,
          starts: c.starts,
          wording: digest("sha256", wording, 16),
        });
        counts.dropped += checked.dropped;
        counts.missing += checked.missing;
        counts.offLine += checked.offLine;
        counts.moves += checked.exchanges.reduce(
          (n, x) => n + x.moves.length,
          0
        );
      },
      { key: c.key }
    );
  };
  // `parallel` calls at once, the next starting as one ends: a reply is kept as it lands, so a stopped pass loses only
  // those in flight.
  const todo = notKept(calls, dir);
  let next = 0;
  const work = async () => {
    while (next < todo.length) {
      const i = next;
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: one worker's calls, one after another
      await one(todo[i] as Call, join(step.dir, `batch-${i}`));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(parallel, todo.length) }, work)
  );
  return counts;
}

/** Who a person is, as a read is told: their name and what they are to him on his map. */
const withOf = (known: string, people: People): With => ({
  name: people.nameOf(`person:${known}`),
  relation: people.truth.people.find((p) => p.id === known)?.relation ?? null,
});

/**
 * About `n` exchanges of everyone but `left`: the newest batch of each person with a one-to-one chat both sides wrote
 * in, people in an order that never changes (a digest of their ref), until the exchanges are enough. One batch a
 * person, so the sample spreads over people, channels and languages.
 */
export function sampleOf(
  events: SourceEvent[],
  people: People,
  left: ReadonlySet<string>,
  n: number,
  wording: string
) {
  const everyone = [...directChats(events, people.resolve)]
    .filter(([ref]) => ref.startsWith("person:") && !left.has(ref))
    .toSorted(([a], [b]) =>
      digest("sha1", a, 12).localeCompare(digest("sha1", b, 12))
    );
  const calls: Call[] = [];
  let exchanges = 0;
  for (const [ref, messages] of everyone) {
    if (exchanges >= n) {
      break;
    }
    const newest = callsOf(
      messages,
      withOf(ref.slice("person:".length), people),
      wording
    ).at(-1);
    if (newest) {
      calls.push(newest);
      exchanges += newest.starts.length;
    }
  }
  return calls;
}

/** Every call of everyone with a one-to-one chat both sides wrote in, all years: the history's one read. */
export const allOf = (events: SourceEvent[], people: People, wording: string) =>
  [...directChats(events, people.resolve)]
    .filter(([ref]) => ref.startsWith("person:"))
    .flatMap(([ref, messages]) =>
      callsOf(messages, withOf(ref.slice("person:".length), people), wording)
    );

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      all: { type: "boolean" },
      effort: { type: "string" },
      engine: { type: "string" },
      label: { type: "string" },
      model: { type: "string" },
      set: { type: "string" },
      last: { type: "string" },
      parallel: { type: "string" },
      run: { type: "boolean" },
      sample: { type: "string" },
    },
  });
  const [name = "", ...names] = positionals;
  const read: Read | undefined = READS[name as ReadName];
  if (!read || (names.length === 0 && !values.all && !values.set)) {
    throw new Error(
      `usage: bun scripts/memory-pilot.ts <${Object.keys(READS).join("|")}> <person>… [--run] [--engine <engine>] [--last <n>] [--sample <n>]`
    );
  }
  const engine = Engine.optional().parse(values.engine);
  // `--model` and `--effort` name another model of the engine (the reference, a second family); `--label` the folder
  // its replies are kept in, so two models of one engine never share one.
  const main = llmFor("main", engine);
  const llm = {
    ...main,
    effort: values.effort ?? main.effort,
    model: values.model ?? main.model,
  };
  console.log(`${name} on ${llmSpec(llm)}`);
  const wording = await promptText(read.prompt);
  const dir = join(KEPT, name, values.label ?? llm.engine);
  // A test set is read from its file: no source is opened.
  const { events, failed } = values.set
    ? { events: [], failed: [] }
    : await readWithPeople(new Date(0));
  const people = await readPeople();
  const named = directOf(names, events, people);
  const last = values.last ? Number(values.last) : undefined;
  const calls = values.set
    ? readSet(values.set).map((s) => callOf(s.batch, s.with, wording))
    : values.all
      ? allOf(events, people, wording)
      : values.sample
        ? sampleOf(
            events,
            people,
            new Set(
              named.flatMap((p) => (p.known ? [`person:${p.known}`] : []))
            ),
            Number(values.sample),
            wording
          )
        : named.flatMap(({ known, messages }, i) => {
            const all = known
              ? callsOf(messages, withOf(known, people), wording)
              : [];
            const mine = last ? all.slice(-last) : all;
            console.log(
              `Person ${i + 1}${known ? "" : ": no one by that name"}`
            );
            console.table([countsOf(mine, dir, wording)]);
            return mine;
          });
  if (values.sample || values.all || values.set) {
    console.log(
      `${values.set ?? (values.all ? "All" : "Sample")}: ${calls.length} calls, ${calls.reduce((n, c) => n + c.starts.length, 0)} exchanges, ${calls.reduce((n, c) => n + c.messages.length, 0)} messages`
    );
    console.table([countsOf(calls, dir, wording)]);
  }
  if (values.run) {
    await spareQuota(llm.engine);
    const begun = await begin(
      "pilot",
      "main",
      { prompt: read.prompt, read: name },
      engine
    );
    const step = {
      ...begun,
      ask: (o: Parameters<typeof begun.ask>[0]) =>
        askOnce({ ...o, llm, run: begun.run }),
      llm,
    };
    console.table([
      step.end(
        await makeCalls(
          calls,
          step,
          read.prompt,
          wording,
          dir,
          name as ReadName,
          values.parallel ? Number(values.parallel) : undefined
        )
      ),
    ]);
  }
  console.log(
    failed.length > 0
      ? `Not read, so missing above: ${failed.join(", ")}`
      : "Every source was read."
  );
}
