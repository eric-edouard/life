// `bun scripts/memory-pilot.ts <read> --set <name> [--prompt <name>] [--first <n>] [--run] [--parallel <n>] [--engine <engine>]
// [--label <label>] [--model <model>] [--effort <effort>]`: the memory rework's pilot (docs/operations.md, "Measuring"): a read
// tried on a saved test set (`pilot-set.ts`, `pilot-voice-set.ts`), its replies kept in a trial folder of their own by read,
// label and prompt digest, never in `memory/`. Calls, storing and "already read" are the exchange reads' (`memory/exchange-reads.ts`).
// Without `--prompt` it asks the read's live prompt, built as the night builds it; `--prompt` names another wording (a version
// file beside the live ones) and builds the call that wording takes (`callOf`). Without `--run` it only counts what it would
// ask. Prints counts, never a word or a name.

import { readdirSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { readJson } from "@life/server/src/core/files";
import { Engine } from "@life/server/src/core/names";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import {
  type Asked,
  callOf,
  directCallOf,
  makeReplies,
  promptDigestOf,
  READS,
  type ReadCall,
  readReplies,
  readReplyIndex,
  replyOf,
  type With,
} from "@life/server/src/memory/exchange-reads";
import { exchangesOf } from "@life/server/src/memory/exchanges";
import { MEMORY } from "@life/server/src/memory/memory-files";
import { refContext } from "@life/server/src/memory/model-context";
import { checkedOf } from "@life/server/src/memory/moves";
import { begin } from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
import { tiesNow } from "@life/server/src/memory/ties";
import { readPeople } from "@life/server/src/memory/who";
import {
  askOnce,
  CHARS_PER_TOKEN,
  callsAtOnceOf,
  llmFor,
  llmSpec,
  promptText,
} from "@life/server/src/models/llm";
import type { ReadName } from "@life/server/src/records/read-reply";
import { chatGroups, type SourceEvent } from "@life/server/src/records/source";

/** Where the pilot keeps its files: his data, outside `memory/`, so no lock and no nightly step reads it. */
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

/**
 * A path inside the pilot's folder (`kept`), never inside `memory/`: where a trial reads and writes. Any other path
 * is refused, so a label or a folder name can never send a trial's replies to where the night keeps its own.
 */
export function trialPath(parts: string[], kept = KEPT, memory = MEMORY) {
  const dir = resolve(kept, ...parts);
  const isInside = (root: string) =>
    dir === root || dir.startsWith(`${root}${sep}`);
  if (!isInside(resolve(kept)) || dir === resolve(kept) || isInside(memory)) {
    throw new Error(`a trial writes only under ${kept}, not ${dir}`);
  }
  return dir;
}

/** The trial folder of a read tried by `label` with this wording: a reworded prompt of the same name is a new folder, so it is asked again. */
export const trialDir = (read: ReadName, label: string, wording: string) =>
  trialPath([read, `${label}-${promptDigestOf(wording)}`]);

/** The folders in `dir`: a stray file (Finder's .DS_Store) is no trial. */
export const foldersIn = (dir: string) =>
  readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

/**
 * The folder of a read's trial named by `label`: the one folder called `<label>-<16 hex>`, or the full name when
 * it is one; else an error listing the folders.
 */
export function folderOf(read: ReadName, label: string, root = KEPT) {
  const dir = trialPath([read], root);
  const names = foldersIn(dir);
  const found = names.includes(label)
    ? [label]
    : names.filter((n) => n.replace(TRIAL_SUFFIX, "") === label);
  if (found.length !== 1) {
    throw new Error(
      `${found.length} folders for ${read} ${label}: ${names.join(", ")}`
    );
  }
  return trialPath([read, found[0] as string], root);
}

/**
 * What a trial folder holds, checked: `checkedOf` over it. `speakerOf` is how its call named each speaker (without it, a
 * move's `aimedAt` is dropped).
 */
export const readKept = (
  read: ReadName,
  folder: string,
  events: Map<string, SourceEvent>,
  speakerOf?: (e: SourceEvent) => string
) => checkedOf(readReplies(folder).flat(), read, events, speakerOf);

/**
 * The lines a call shows before its first exchange: the messages of the same chat in `whole` (the whole test set) said
 * before it, kept when they are one exchange with it (`exchangesOf`: a set cut inside a conversation, as the
 * recordings are, never a chat's).
 */
export function earlierOf(batch: SourceEvent[][], whole: SourceEvent[]) {
  const first = batch[0]?.[0];
  if (!first) {
    return [];
  }
  const before = (
    chatGroups(whole).get(`${first.source}|${first.chat}`) ?? []
  ).filter((e) => e.at < first.at);
  return (exchangesOf([...before, first]).at(-1) ?? []).slice(0, -1);
}

const TRIAL_SUFFIX = /-[0-9a-f]{16}$/;
const REFUSED = /\b429\b|rate.?limit/i;

/** The most people one call may involve, and the most tokens a call may average: a run over either stops (the last trial: 400 people, 25,000 tokens). */
const MOST_INVOLVED = 40;
const MOST_TOKENS_MEAN = 9000;
/** The most calls in flight at once, however `--parallel` is set. */
const MOST_PARALLEL = 96;

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      effort: { type: "string" },
      engine: { type: "string" },
      first: { type: "string" },
      label: { type: "string" },
      model: { type: "string" },
      parallel: { type: "string" },
      prompt: { type: "string" },
      run: { type: "boolean" },
      set: { type: "string" },
    },
  });
  const name = positionals[0] as ReadName;
  const live: { prompt: string } | undefined = READS[name];
  if (!(live && values.set)) {
    throw new Error(
      `usage: bun scripts/memory-pilot.ts <${Object.keys(READS).join("|")}> --set <name> [--prompt <name>] [--first <n>] [--run] [--parallel <n>] [--engine <engine>] [--label <label>] [--model <model>] [--effort <effort>]`
    );
  }
  const prompt = values.prompt ?? live.prompt;
  const isLive = prompt === live.prompt;
  const parallel = values.parallel ? Number(values.parallel) : undefined;
  if (parallel !== undefined && !(parallel >= 1 && parallel <= MOST_PARALLEL)) {
    throw new Error(`--parallel is 1 to ${MOST_PARALLEL}`);
  }
  const engine = Engine.optional().parse(values.engine);
  // `--model` and `--effort` name another model of the engine (the reference, a second family); `--label` names the
  // trial folder its replies are kept in, so two models of one engine never share one.
  const main = llmFor("main", engine);
  const llm = {
    ...main,
    effort: values.effort ?? main.effort,
    model: values.model ?? main.model,
  };
  console.log(`${name} on ${llmSpec(llm)}, prompt ${prompt}`);
  const wording = await promptText(prompt);
  const trial = trialDir(name, values.label ?? llm.engine, wording);
  console.log(`trial folder ${basename(trial)}`);
  const index = readReplyIndex(trial, () => prompt);
  const set = readSet(values.set);
  const whole = set.flatMap((s) => s.batch.flat());
  const people = await readPeople();
  const ties = tiesNow(people);
  const directory = refContext(people, new Set(), new Set());
  const entries = set.slice(0, values.first ? Number(values.first) : undefined);
  const calls = entries
    .filter((s) => !s.batch.every((x) => replyOf(x, name, index)))
    .map(
      (
        s
      ): {
        call: ReadCall;
        cut: boolean;
        earlier: number;
        involved: number;
      } => {
        if (isLive) {
          return {
            call: directCallOf(s.batch, s.with),
            cut: false,
            earlier: 0,
            involved: 0,
          };
        }
        const earlier = earlierOf(s.batch, whole);
        const call = callOf(s.batch, people, ties, directory, earlier);
        return {
          call,
          cut: call.earlierCut,
          earlier: call.messages.length - s.batch.flat().length,
          involved: call.input.involved.length,
        };
      }
    );
  const asked: Asked[] = calls.map((c) => ({
    at: "",
    call: c.call,
    prompt,
    read: name,
  }));
  const tokensAtMost = Math.ceil(
    asked.reduce(
      (n, a) => n + wording.length + JSON.stringify(a.call.input).length,
      0
    ) / CHARS_PER_TOKEN
  );
  const involvedMost = Math.max(0, ...calls.map((c) => c.involved));
  console.table([
    {
      batches: entries.length,
      earlierCut: calls.filter((c) => c.cut).length,
      earlierLines: calls.reduce((n, c) => n + c.earlier, 0),
      involvedMost,
      toAsk: asked.length,
      tokensAtMost,
    },
  ]);
  if (values.run) {
    if (
      involvedMost > MOST_INVOLVED ||
      tokensAtMost / Math.max(1, asked.length) > MOST_TOKENS_MEAN
    ) {
      throw new Error(
        `stopped: over ${MOST_INVOLVED} people in a call or a mean over ${MOST_TOKENS_MEAN} tokens`
      );
    }
    await spareQuota(llm.engine);
    const begun = await begin("pilot", "main", { prompt, read: name }, engine);
    const timed = { calls: 0, refused: 0, seconds: 0 };
    const step = {
      ...begun,
      ask: async (o: Parameters<typeof begun.ask>[0]) => {
        const started = performance.now();
        try {
          return await askOnce({ ...o, llm, run: begun.run });
        } catch (e) {
          timed.refused += REFUSED.test((e as Error).message) ? 1 : 0;
          throw e;
        } finally {
          timed.calls += 1;
          timed.seconds += (performance.now() - started) / 1000;
        }
      },
      llm,
    };
    // The first calls alone, timed, with any refusal counted, before the rest go on; at most MOST_PARALLEL at once.
    const atOnce = parallel ?? callsAtOnceOf(llm);
    const firstOnes = await makeReplies(
      asked.slice(0, atOnce),
      step,
      trial,
      atOnce
    );
    console.table([
      {
        meanSeconds: Math.round(timed.seconds / Math.max(1, timed.calls)),
        refused: timed.refused,
        stored: firstOnes.stored,
        timedCalls: timed.calls,
      },
    ]);
    if (firstOnes.stored === 0 && asked.length > 0) {
      throw new Error("the first calls stored nothing: stopped");
    }
    const rest = await makeReplies(asked.slice(atOnce), step, trial, atOnce);
    console.table([step.end({ stored: firstOnes.stored + rest.stored })]);
  }
}
