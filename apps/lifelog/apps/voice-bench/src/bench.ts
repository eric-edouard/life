// The voice bench: which speaker-embedding model, or blend of models, names the most of the owner's
// known voices. Everything it reads or writes holds his voice and stays in DIR, out of the repo.
//   bun run bench sample [count] [seed]  every turn he answered and a draw of the others (sample.json)
//   bun run bench clips                  each turn as a WAV (clips/)
//   bun run bench embed [model…]         the models over every clip (embeddings/), all by default
//   bun run bench score                  every model and blend against his answers (report.json, report.md)
//   bun run bench page                   the report, the cloud and the review, on this Mac only
//   bun run bench all                    clips, embed, score, in order (after a first `sample`)
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSample, type Sample } from "./archive";
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

const STEPS: Record<string, (...args: string[]) => Promise<unknown>> = {
  all: async () => {
    await clips();
    await embed();
    await score();
  },
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
