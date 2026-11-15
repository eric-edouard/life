// `bun scripts/memory-pilot.ts <read> --set <name> [--run] [--engine <engine>] [--label <label>] [--model <model>]
// [--effort <effort>]`: the memory rework's pilot (docs/operations.md, "Measuring"): a read tried on a saved test set
// (`pilot-set.ts`, `pilot-voice-set.ts`), its replies kept in a trial folder of their own by read, label and prompt digest,
// never in `memory/`. Calls, storing and "already read" are the exchange reads' (`memory/exchange-reads.ts`). Without
// `--run` it only counts what it would ask. Prints counts, never a word or a name.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { readJson } from "@life/server/src/core/files";
import { Engine } from "@life/server/src/core/names";
import { OWNER_DATA_DIR } from "@life/server/src/core/paths";
import {
  type Asked,
  callOf,
  makeReplies,
  promptDigestOf,
  READS,
  readReplies,
  readReplyIndex,
  replyOf,
  type With,
} from "@life/server/src/memory/exchange-reads";
import { checkedOf } from "@life/server/src/memory/moves";
import { begin } from "@life/server/src/memory/run";
import { spareQuota } from "@life/server/src/memory/schedule";
import {
  askOnce,
  CHARS_PER_TOKEN,
  llmFor,
  llmSpec,
  promptText,
} from "@life/server/src/models/llm";
import type { ReadName } from "@life/server/src/records/read-reply";
import type { SourceEvent } from "@life/server/src/records/source";

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

/** The trial folder of a read tried by `label` with this wording: a reworded prompt of the same name is a new folder, so it is asked again. */
export const trialDir = (read: ReadName, label: string, wording: string) =>
  join(KEPT, read, `${label}-${promptDigestOf(wording)}`);

/** What a trial read stored under `label` with this wording, checked: `checkedOf` over its folder. */
export const readKept = (
  read: ReadName,
  label: string,
  events: Map<string, SourceEvent>,
  wording: string
) =>
  checkedOf(readReplies(trialDir(read, label, wording)).flat(), read, events);

if (import.meta.main) {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      effort: { type: "string" },
      engine: { type: "string" },
      label: { type: "string" },
      model: { type: "string" },
      run: { type: "boolean" },
      set: { type: "string" },
    },
  });
  const name = positionals[0] as ReadName;
  const read: { prompt: string } | undefined = READS[name];
  if (!(read && values.set)) {
    throw new Error(
      `usage: bun scripts/memory-pilot.ts <${Object.keys(READS).join("|")}> --set <name> [--run] [--engine <engine>] [--label <label>] [--model <model>] [--effort <effort>]`
    );
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
  console.log(`${name} on ${llmSpec(llm)}`);
  const wording = await promptText(read.prompt);
  const trial = trialDir(name, values.label ?? llm.engine, wording);
  const index = readReplyIndex(trial);
  const toAsk = readSet(values.set).filter(
    (s) => !s.batch.every((x) => replyOf(x, name, index))
  );
  const asked: Asked[] = toAsk.map((s) => ({
    at: "",
    call: callOf(s.batch, s.with),
    read: name,
  }));
  console.table([
    {
      batches: readSet(values.set).length,
      toAsk: asked.length,
      tokensAtMost: Math.ceil(
        asked.reduce(
          (n, a) => n + wording.length + JSON.stringify(a.call.input).length,
          0
        ) / CHARS_PER_TOKEN
      ),
    },
  ]);
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
    console.table([step.end(await makeReplies(asked, step, trial))]);
  }
}
