// `bun scripts/memory-pilot.ts <read> <person>… [--run] [--engine <engine>]`: the memory rework's pilot
// (docs/operations.md, "Measuring"). For each person named, their one-to-one chats both sides wrote in, a batch of
// exchanges per call. Without `--run` it only counts what it would ask. Prints counts, never a word or a name.

import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { Engine } from "@life/server/src/core/names";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import { directOf, readWithPeople } from "@life/server/src/memory/closeness";
import { batchesOf, isLiving } from "@life/server/src/memory/exchanges";
import { locate } from "@life/server/src/memory/observe";
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
/** A line this short is quoted whole, by code: the quote check refuses very short quotes, and a move is often one. */
const WHOLE_UNDER = 40;

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
    .optional(),
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
const Tone = z.enum(["warm", "neutral", "cold"]);
const Reply = z.object({
  exchanges: z.array(
    z.object({
      exchange: z.int().min(0),
      moves: z.array(z.unknown()),
      tension: z.boolean(),
      tone: z.object({ me: Tone.optional(), them: Tone.optional() }),
    })
  ),
});

/** The words of a move in the batch, and the line they are on: a short line whole, else the quote where it is found. */
const quoted = (m: Move, texts: string[]) => {
  const whole = texts[m.line] ?? "";
  return whole.length < WHOLE_UNDER
    ? { line: m.line, verbatim: whole }
    : locate(m.quote, texts, m.line);
};

/**
 * A reply's moves as code accepts them: a known code, on a line of the batch, its words found there (`quoted`), one
 * per code and person in an exchange. Who made a move and when come from the message, never from the reply. Throws on
 * a reply that is not one, so it is never kept. `dropped`: marks refused; `offLine`: quotes found on another line.
 */
export function checkedMoves(reply: unknown, messages: SourceEvent[]) {
  const texts = messages.map(textOf);
  let dropped = 0;
  let offLine = 0;
  const exchanges = Reply.parse(reply).exchanges.map((x) => {
    const { entries, invalid } = checkedEntries(
      x.moves,
      Move,
      (m) => `${m.line}|${m.code}`,
      (key) => messages[Number.parseInt(key, 10)] !== undefined
    );
    const seen = new Set<string>();
    const moves = entries.flatMap((m) => {
      const found = quoted(m, texts);
      const message = found ? messages[found.line] : undefined;
      const by = message?.fromMe ? "me" : "them";
      if (!(found && message) || seen.has(`${by}|${m.code}`)) {
        return [];
      }
      seen.add(`${by}|${m.code}`);
      offLine += found.line === m.line ? 0 : 1;
      return [
        { ...m, at: message.at, by, line: found.line, quote: found.verbatim },
      ];
    });
    dropped += invalid + entries.length - moves.length;
    return { exchange: x.exchange, moves, tension: x.tension, tone: x.tone };
  });
  return { dropped, exchanges, offLine };
}

interface With {
  name: string;
  relation: string | null;
}
/** One call: what the model is shown, the messages its lines are, and the key its reply is kept under. */
type Ask = ReturnType<typeof askOf>;
function askOf(batch: SourceEvent[][], withWhom: With | null, prompt: string) {
  const { lines, messages } = batchLines(batch, (e) =>
    e.fromMe ? "me" : (withWhom?.name ?? "them")
  );
  const input = { lines, with: withWhom };
  return { input, key: inputsOf(prompt, input), messages };
}

/**
 * The calls for one person: a batch of exchanges each, over their one-to-one chats both sides wrote in. `prompt` is
 * the prompt's text, so a reply is kept for the wording that made it: the pilot rewords between rounds.
 */
export const asksOf = (
  messages: SourceEvent[],
  withWhom: With | null,
  prompt: string
) =>
  [...chatGroups(messages).values()]
    .filter(isLiving)
    .flatMap((chat) =>
      batchesOf(chat).map((batch) => askOf(batch, withWhom, prompt))
    );

const keptAt = (dir: string, key: string) => join(dir, `${key}.json`);

/** What a pass over `asks` would ask and what is kept already; tokens at most, the prompt counted in every call. */
export function countsOf(asks: Ask[], dir: string, promptChars: number) {
  const toAsk = asks.filter((a) => !existsSync(keptAt(dir, a.key)));
  const chars = toAsk.reduce(
    (n, a) => n + promptChars + JSON.stringify(a.input).length,
    0
  );
  return {
    batches: asks.length,
    keptAlready: asks.length - toAsk.length,
    toAsk: toAsk.length,
    tokensAtMost: Math.ceil(chars / CHARS_PER_TOKEN),
  };
}

/**
 * Asks every call not kept yet, a few at a time. A reply whose shape is one is kept as the model gave it, with what
 * made it and the messages it read; its moves are worked out from it when read (`checkedMoves`), never stored. A call
 * that fails, or a reply that is not one, keeps nothing and is asked again at the next pass.
 */
export async function readAll(
  asks: Ask[],
  step: Pick<Step, "ask" | "attempt" | "dir" | "llm" | "run">,
  prompt: string,
  dir: string
) {
  const counts = { dropped: 0, moves: 0, offLine: 0 };
  await mkdir(dir, { recursive: true });
  const toAsk = asks.filter((a) => !existsSync(keptAt(dir, a.key)));
  await inBatches(toAsk, step.dir, async (a, bdir) => {
    await step.attempt(
      async () => {
        const reply = await step.ask({ dir: bdir, input: a.input, prompt });
        const checked = checkedMoves(reply, a.messages);
        await Bun.write(
          keptAt(dir, a.key),
          `${JSON.stringify({ madeBy: stamp(step.llm, prompt, step.run), messages: a.messages.map((m) => `${m.source}|${m.id}`), reply }, null, 2)}\n`
        );
        counts.dropped += checked.dropped;
        counts.offLine += checked.offLine;
        counts.moves += checked.exchanges.reduce(
          (n, x) => n + x.moves.length,
          0
        );
      },
      { key: a.key }
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
  const engine = values.engine as Engine | undefined;
  const llm = llmFor("main", engine);
  console.log(`${name} on ${llmSpec(llm)}`);
  const prompt = await promptText(read.prompt);
  const { events, failed } = await readWithPeople(new Date(0));
  const people = await readPeople();
  const dir = join(KEPT, name, llm.engine);
  const asks = directOf(names, events, people).map(({ known, messages }, i) => {
    const mine = asksOf(messages, known ? withOf(known, people) : null, prompt);
    console.log(`Person ${i + 1}${known ? "" : ": no one by that name"}`);
    console.table([countsOf(mine, dir, prompt.length)]);
    return mine;
  });
  if (values.run) {
    await spareQuota(llm.engine);
    const step = await begin(
      `pilot-${name}`,
      "main",
      { prompt: read.prompt },
      engine
    );
    console.table([
      step.end(await readAll(asks.flat(), step, read.prompt, dir)),
    ]);
  }
  console.log(
    failed.length > 0
      ? `Not read, so missing above: ${failed.join(", ")}`
      : "Every source was read."
  );
}
