// `bun scripts/memory-pilot.ts <read> <person>… [--run] [--engine <engine>]`: the memory rework's pilot
// (docs/operations.md, "Measuring"). For each person named, their one-to-one chats both sides wrote in, a batch of
// exchanges per call. Without `--run` it only counts what it would ask. Prints counts, never a word or a name.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { writeJson } from "@life/server/src/core/files";
import { Engine } from "@life/server/src/core/names";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import { directOf, readWithPeople } from "@life/server/src/memory/closeness";
import { batchesOf, isLiving } from "@life/server/src/memory/exchanges";
import { folded, locate } from "@life/server/src/memory/observe";
import {
  begin,
  checkedEntries,
  inBatches,
  inputsOf,
  type Step,
} from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
import { textOf } from "@life/server/src/memory/units";
import { type People, readPeople } from "@life/server/src/memory/who";
import { batchLines } from "@life/server/src/memory/words";
import {
  CHARS_PER_TOKEN,
  llmFor,
  llmSpec,
  promptText,
  stamp,
} from "@life/server/src/models/llm";
import { chatGroups, type SourceEvent } from "@life/server/src/records/source";
import { z } from "zod";

/** The reads the pilot knows, each by its prompt. */
const READS: Record<string, { prompt: string }> = {
  connection: { prompt: "memory-connection.v1" },
};
/** Where a reply is kept, by read and engine: his data, outside `memory/`, so no lock and no nightly step reads it. */
const KEPT = join(OWNER_DATA_DIR, "docs", "memory-rework", "pilot");

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
const Move = z.discriminatedUnion("code", [
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
type Move = z.infer<typeof Move>;
const Tone = z.enum(["warm", "neutral", "cold"]).nullish();
/** One exchange of a reply; its moves are checked one by one (`movesOf`). */
const Read = z.object({
  exchange: z.int().min(0),
  moves: z.array(z.unknown()),
  tension: z.boolean(),
  tone: z.object({ me: Tone, them: Tone }),
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
  const answer = "answer" in m ? m.answer : undefined;
  const reply = answer ? span.messages[answer.line - span.start] : undefined;
  return answer && reply && answer.line > line && reply.fromMe !== by.fromMe
    ? answer
    : undefined;
}

/**
 * The moves of one exchange code accepts: a known code, on a line of the exchange that is not a call, its words found
 * there, one per code and person.
 */
function movesOf(raw: unknown[], span: Span) {
  const { entries } = checkedEntries(
    raw,
    Move,
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
    const vote = `${message?.fromMe}|${m.code}`;
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
  starts: number[]
) {
  const spans = new Map(
    starts.map((start, i): [number, Span] => {
      const end = starts[i + 1] ?? messages.length;
      return [start, { end, messages: messages.slice(start, end), start }];
    })
  );
  const { entries } = checkedEntries(
    Reply.parse(reply).exchanges,
    Read,
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
      spans.get(x.exchange) as Span
    );
    counts.dropped += dropped;
    counts.offLine += offLine;
    return { exchange: x.exchange, moves, tension: x.tension, tone: x.tone };
  });
  return { ...counts, exchanges };
}

interface With {
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
  dir: string
) {
  const counts = { dropped: 0, missing: 0, moves: 0, offLine: 0 };
  await inBatches(notKept(calls, dir), step.dir, async (c, bdir) => {
    await step.attempt(
      async () => {
        const reply = await step.ask({ dir: bdir, input: c.input, prompt });
        const checked = checkedMoves(reply, c.messages, c.starts);
        writeJson(join(dir, `${c.key}.json`), {
          madeBy: stamp(step.llm, prompt, step.run),
          messages: c.messages.map((m) => `${m.source}|${m.id}`),
          reply,
          starts: c.starts,
          wording: inputsOf(wording, null),
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
  });
  return counts;
}

/** Who a person is, as a read is told: their name and what they are to him on his map. */
const withOf = (known: string, people: People): With => ({
  name: people.nameOf(`person:${known}`),
  relation: people.truth.people.find((p) => p.id === known)?.relation ?? null,
});

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { engine: { type: "string" }, run: { type: "boolean" } },
  });
  const [name = "", ...names] = positionals;
  const read = READS[name];
  if (!read || names.length === 0) {
    throw new Error(
      `usage: bun scripts/memory-pilot.ts <${Object.keys(READS).join("|")}> <person>… [--run] [--engine <engine>]`
    );
  }
  const engine = Engine.optional().parse(values.engine);
  const llm = llmFor("main", engine);
  console.log(`${name} on ${llmSpec(llm)}`);
  const wording = await promptText(read.prompt);
  const { events, failed } = await readWithPeople(new Date(0));
  const people = await readPeople();
  const dir = join(KEPT, name, llm.engine);
  const calls = directOf(names, events, people).flatMap(
    ({ known, messages }, i) => {
      const mine = known
        ? callsOf(messages, withOf(known, people), wording)
        : [];
      console.log(`Person ${i + 1}${known ? "" : ": no one by that name"}`);
      console.table([countsOf(mine, dir, wording)]);
      return mine;
    }
  );
  if (values.run) {
    await spareQuota(llm.engine);
    const step = await begin(
      "pilot",
      "main",
      { prompt: read.prompt, read: name },
      engine
    );
    console.table([
      step.end(await makeCalls(calls, step, read.prompt, wording, dir)),
    ]);
  }
  console.log(
    failed.length > 0
      ? `Not read, so missing above: ${failed.join(", ")}`
      : "Every source was read."
  );
}
