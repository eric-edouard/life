// The voice bench: which speaker-embedding model, or blend of models, names the most of the owner's
// known voices. Everything it reads or writes holds his voice and stays in DIR, out of the repo.
//   bun run bench sample [count] [seed]  every turn he answered and a draw of the others (sample.json)
//   bun run bench clips                  each turn as a WAV (clips/)
//   bun run bench embed [model…]         the models over every clip (embeddings/), all by default
//   bun run bench score                  every model and blend against his answers (report.json, report.md)
//   bun run bench page                   the report, the cloud and the review, on this Mac only
//   bun run bench apply [--write] [person id to leave out…]  his review answers that differ from the archive,
//                                        listed, or sent to lifelog's server (PORT, LIFELOG_TOKEN)
//   bun run bench all                    clips, embed, score, in order (after a first `sample`)
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { send, writesOf } from "./apply";
import { readNames, readSample, type Sample } from "./archive";
import { cutClips } from "./clips";
import { serve } from "./page";
import { type Embedded, markdownOf, reportOf } from "./report";
import { readAnswers } from "./truth";

const DIR =
  process.env.VOICE_BENCH_DIR ??
  join(homedir(), "Life/docs/lifelog/voice-bench");
const EMBEDDINGS = join(DIR, "embeddings");
const ANSWERS = join(DIR, "answers.jsonl");
const LOCAL = join(import.meta.dir, "../local");

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await Bun.file(path).text());
const readDrawn = () => readJson<Sample>(join(DIR, "sample.json"));

async function sample(count = "1500", seed = "1") {
  const drawn = readSample(Number(count), seed);
  await Bun.write(join(DIR, "sample.json"), JSON.stringify(drawn));
  console.log(`${drawn.turns.length} turns in sample.json`);
}

async function clips() {
  await mkdir(join(DIR, "clips"), { recursive: true });
  const { cut, failed } = await cutClips(DIR, (await readDrawn()).turns);
  console.log(
    `cut ${cut} jobs' turns${failed.length ? `, ${failed.length} failed:\n${failed.join("\n")}` : ""}`
  );
}

// The models are Python's (local/embed.py): it embeds the clips a model has not heard yet.
async function embed(...models: string[]) {
  await mkdir(EMBEDDINGS, { recursive: true });
  const proc = Bun.spawn(
    [
      "uv",
      "run",
      "--project",
      LOCAL,
      "python",
      join(LOCAL, "embed.py"),
      DIR,
      ...models,
    ],
    { stderr: "inherit", stdout: "inherit" }
  );
  if ((await proc.exited) !== 0) {
    throw new Error(`embed.py exited ${proc.exitCode}`);
  }
}

// embeddings/<model>@<revision>.json names the clips, in the order of the vectors in its .f32.
async function readEmbeddings(): Promise<Embedded[]> {
  const metas = (await readdir(EMBEDDINGS).catch(() => [])).filter((f) =>
    f.endsWith(".json")
  );
  return Promise.all(
    metas.map(async (file) => {
      const meta = await readJson<
        Omit<Embedded, "vectors" | "key"> & { ids: string[] }
      >(join(EMBEDDINGS, file));
      const all = new Float32Array(
        await Bun.file(
          join(EMBEDDINGS, file.replace(".json", ".f32"))
        ).arrayBuffer()
      );
      return {
        dim: meta.dim,
        key: file.replace(".json", ""),
        model: meta.model,
        secondsPerClip: meta.secondsPerClip,
        vectors: new Map(
          meta.ids.map((id, i) => [
            id,
            Array.from(all.subarray(i * meta.dim, (i + 1) * meta.dim)),
          ])
        ),
      };
    })
  );
}

async function score() {
  const started = performance.now();
  const report = reportOf(
    await readDrawn(),
    await readAnswers(ANSWERS),
    await readEmbeddings()
  );
  await Bun.write(join(DIR, "report.json"), JSON.stringify(report));
  await Bun.write(join(DIR, "report.md"), markdownOf(report));
  console.log(markdownOf(report));
  console.log(
    `scored in ${((performance.now() - started) / 1000).toFixed(1)} s`
  );
}

async function apply(...args: string[]) {
  const [archive, people] = readNames();
  const except = args.filter((a) => a !== "--write");
  const stranger = except.find((id) => !people.has(id));
  if (stranger) {
    throw new Error(`no person ${stranger} in the archive`);
  }
  const { left, writes } = writesOf(
    (await readDrawn()).turns,
    await readAnswers(ANSWERS),
    archive,
    people,
    except
  );
  const scopeOf = (w: (typeof writes)[number]) =>
    `${w.turnIndex === undefined ? "whole voice" : "one turn"}, ${w.kind}`;
  const print = (counts: Map<string, unknown[]>) => {
    for (const [what, group] of [...counts].sort()) {
      console.log(`${group.length}\t${what}`);
    }
  };
  print(Map.groupBy(writes, scopeOf));
  console.log(`${writes.length} to write, ${left} answers left out`);
  if (!args.includes("--write")) {
    return;
  }
  const { LIFELOG_TOKEN: token, PORT: port } = process.env;
  if (!(token && port)) {
    throw new Error("set PORT (server.env) and LIFELOG_TOKEN (Life's .env)");
  }
  const refused: [number, string][] = [];
  for (const write of writes) {
    // biome-ignore lint/performance/noAwaitInLoops: one writer, in order
    const status = await send(`http://127.0.0.1:${port}`, token, write);
    if (status !== 200) {
      refused.push([status, scopeOf(write)]);
    }
  }
  console.log(`${writes.length - refused.length} written`);
  if (refused.length) {
    console.log("refused by lifelog, still to write:");
    print(Map.groupBy(refused, ([status, what]) => `${status}: ${what}`));
    process.exitCode = 1;
  }
}

const STEPS: Record<string, (...args: string[]) => Promise<unknown>> = {
  all: async () => {
    await clips();
    await embed();
    await score();
  },
  apply,
  clips,
  embed,
  page: () => serve(DIR, ANSWERS, score),
  sample,
  score,
};

if (import.meta.main) {
  const [step = "", ...args] = Bun.argv.slice(2);
  const run = STEPS[step];
  if (!run) {
    throw new Error(`a step: ${Object.keys(STEPS).join(", ")}`);
  }
  await mkdir(DIR, { recursive: true });
  await run(...args);
}
