// `bun scripts/memory-pilot.ts <read> <person>… [--run] [--engine <engine>] [--last <n>] [--sample <n>] | --all`: the memory
// rework's pilot (docs/operations.md, "Measuring"). For each person named, their one-to-one chats both sides wrote in,
// a batch of exchanges per call; `--last` keeps each person's newest batches only (the second family's check);
// `--sample` reads about that many exchanges of everyone else instead, the people named left out. Without `--run` it
// only counts what it would ask. Prints counts, never a word or a name.

import { existsSync, readdirSync } from "node:fs";
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
import {
  type CheckedExchange,
  checkedMoves,
} from "@life/server/src/memory/moves";
import {
  begin,
  inBatches,
  inputsOf,
  type Step,
} from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
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
import type { ReadName } from "@life/server/src/records/read-reply";
import {
  chatGroups,
  eventKey,
  type SourceEvent,
} from "@life/server/src/records/source";

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

/** The prompt of each read; its moves' shape is `MOVES`, `memory/moves.ts`. */
export const READS = {
  conflict: { prompt: "memory-conflict.v2" },
  connection: { prompt: "memory-connection.v3" },
  mentions: { prompt: "memory-mentions.v1" },
} satisfies Record<ReadName, { prompt: string }>;

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

/** A kept reply: the reply as given, the keys of the messages it read, where each exchange starts, the wording's digest. */
interface Kept {
  messages: string[];
  reply: unknown;
  starts: number[];
  wording: string;
}
const wordingOf = (wording: string) => digest("sha256", wording, 16);

/**
 * Every exchange a read's kept replies hold under `label`, checked (`checkedMoves`), by its first message's key:
 * only replies to this `wording` (a folder can hold several wordings' replies) whose messages are all in `events`.
 */
export function readKept(
  read: ReadName,
  label: string,
  events: Map<string, SourceEvent>,
  wording: string
) {
  const dir = join(KEPT, read, label);
  const out = new Map<string, CheckedExchange>();
  for (const file of existsSync(dir) ? readdirSync(dir) : []) {
    const kept = readJson<Kept>(join(dir, file));
    const messages = kept?.messages.flatMap((id) => events.get(id) ?? []);
    if (
      kept?.wording === wordingOf(wording) &&
      messages?.length === kept.messages.length
    ) {
      const checked = checkedMoves(kept.reply, messages, kept.starts, read);
      for (const x of checked.exchanges) {
        out.set(kept.messages[x.exchange] as string, x);
      }
    }
  }
  return out;
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
  name: ReadName = "connection"
) {
  const counts = { dropped: 0, missing: 0, moves: 0, offLine: 0 };
  await inBatches(notKept(calls, dir), step, async (c, bdir) => {
    await step.attempt(
      async () => {
        const reply = await step.ask({ dir: bdir, input: c.input, prompt });
        const checked = checkedMoves(reply, c.messages, c.starts, name);
        writeJson(join(dir, `${c.key}.json`), {
          madeBy: stamp(step.llm, prompt, step.run),
          messages: c.messages.map((m) => eventKey(m)),
          reply,
          starts: c.starts,
          wording: wordingOf(wording),
        } satisfies Kept & { madeBy: unknown });
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
export const withOf = (known: string, people: People): With => ({
  name: people.nameOf(`person:${known}`),
  relation: people.truth.people.find((p) => p.id === known)?.relation ?? null,
});

/**
 * About `n` exchanges of everyone but `left`: the newest batch of each person with a one-to-one chat both sides wrote
 * in, people in an order that never changes (a digest of their ref), until the exchanges are enough. One batch a
 * person, so the sample spreads over people, channels and languages.
 */
function sampleOthersOf(
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
      last: { type: "string" },
      model: { type: "string" },
      run: { type: "boolean" },
      sample: { type: "string" },
      set: { type: "string" },
    },
  });
  const [name = "", ...names] = positionals;
  const read: { prompt: string } | undefined = READS[name as ReadName];
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
  const others = () =>
    sampleOthersOf(
      events,
      people,
      new Set(named.flatMap((p) => (p.known ? [`person:${p.known}`] : []))),
      Number(values.sample),
      wording
    );
  const ofNamed = () =>
    named.flatMap(({ known, messages }, i) => {
      const all = known
        ? callsOf(messages, withOf(known, people), wording)
        : [];
      const mine = last ? all.slice(-last) : all;
      console.log(`Person ${i + 1}${known ? "" : ": no one by that name"}`);
      console.table([countsOf(mine, dir, wording)]);
      return mine;
    });
  let calls: Call[];
  if (values.set) {
    calls = readSet(values.set).map((s) => callOf(s.batch, s.with, wording));
  } else if (values.all) {
    calls = allOf(events, people, wording);
  } else {
    calls = values.sample ? others() : ofNamed();
  }
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
          name as ReadName
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
