// The transcription bench: Scribe's stored transcripts against open models run on this Mac.
// Everything it reads or writes holds the owner's voice or words and stays in DIR, out of the repo.
//   bun run bench jobs            the server's completed jobs, no text (jobs.jsonl)
//   bun run bench sample [seed]   the stratified draw (sample.json)
//   bun run bench clips           each drawn job's audio window (.wav) and Scribe's words in it
//   bun run bench run [model…]    the open models over every clip (out/<model>/), all by default
//   bun run bench score           text, language and speakers of each model against Scribe (report.md)
//   bun run bench context [fit]   the server's router on real blocks the speech service hears again
//                                 (context/report.md); `fit` fits its weights (context.ts)
//   bun run bench rediarize       the owner's one-off (11 Nov 2026): each Scribe job's turns from
//                                 local/modal_speakers.py (resplit/) to the server, which relabels
//                                 its speakers (LIFELOG_URL, LIFELOG_DEVICE_TOKEN)
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Word } from "@lifelog/db/schema";
import { context, fit } from "./context";
import { jobRows, storedWords } from "./export";
import {
  GROUPS,
  type Group,
  type Job,
  type Pick,
  sample,
  window,
} from "./sample";
import { type Clip, ONLY_EN, ONLY_FR, type Output, tally } from "./score";

const DIR =
  process.env.STT_BENCH_DIR ?? join(homedir(), "Life/docs/lifelog/stt-bench");
const CLIPS = join(DIR, "clips");
const OUT = join(DIR, "out");
const HERE = import.meta.dir;

// Models, by the name the report uses: a transcriber through mlx-audio (local/run.py, with
// arguments for its `generate`), Kyutai's (local/kyutai.py, a script with its own environment),
// a diarizer (pyannote's, local/diarize.py; NVIDIA's Nemotron 3, local/nemotron.py), or Scribe
// through its paid API (local/scribe.py).
const MODELS: Record<string, string[]> = {
  // Parakeet's larger sibling; no language detection: English and French with the language given.
  // Trained on pieces of up to 40 s, it stops early on a longer one: it hears 30 s at a time.
  canary: [
    "run.py",
    "CogniSoftOrg/canary-1b-v2-mlx-bf16",
    '{"source_lang": "given", "target_lang": "given", "groups": ["en", "fr"], "chunk": 30}',
  ],
  // No language detection and no Thai: run on English and French with the language given.
  cohere: [
    "run.py",
    // Cohere's own repo (gated: terms accepted once), which mlx-audio converts as it loads; the
    // community 8-bit build loads without error but transcribes noise.
    "CohereLabs/cohere-transcribe-03-2026",
    '{"language": "given", "groups": ["en", "fr"]}',
  ],
  // English and French in one model, from Kyutai (Paris); its own runner and environment.
  kyutai: [
    "kyutai.py",
    "kyutai/stt-1b-en_fr-mlx",
    '{"groups": ["en", "fr", "fr+en"]}',
  ],
  // NVIDIA's multilingual streaming model (May 2026), 40 languages, the language detected.
  nemotron: [
    "run.py",
    "mlx-community/nemotron-3.5-asr-streaming-0.6b-8bit",
    '{"language": "auto"}',
  ],
  // NVIDIA, 23 Sep 2026: up to 8 speakers, through its native runtime (NeMo-Speech.cpp).
  "nemotron-diar": ["nemotron.py"],
  // A Parakeet v3 with half its encoder filters refitted (Sep 2026), same size and languages.
  orukeet: [
    "run.py",
    "itsreidar/orukeet-mlx",
    '{"load": {"model_type": "parakeet"}}',
  ],
  parakeet: ["run.py", "mlx-community/parakeet-tdt-0.6b-v3"],
  // Moondream's post-training of Parakeet v3 (22 Sep 2026): same size and languages.
  "parakeet-ultra": ["run.py", "selcukkubur/parakeet-ultra-mlx"],
  pyannote: ["diarize.py"],
  // Capped: over music it can loop for minutes (2 min of speech is about 600 tokens).
  qwen3: [
    "run.py",
    "mlx-community/Qwen3-ASR-1.7B-bf16",
    '{"max_tokens": 2048}',
  ],
  // ElevenLabs Scribe v2 told the language is Thai (paid: 22 Oct, the 16 Thai and mixed clips).
  "scribe-th": [
    "scribe.py",
    "scribe_v2",
    '{"language_code": "tha", "groups": ["th", "mixed"]}',
  ],
  // A Thai fine-tune of Whisper (community MLX build), on the Thai and mixed clips only.
  // Parked on 22 Oct, their partial runs kept in parked/: Pathumma (NECTEC's Thai Whisper), slower
  // than real time and behind Qwen3 on Thai; VibeVoice ASR, real time only and making up French; and
  // Voxtral Mini 4B Realtime, slow and far behind Parakeet Ultra on its first clips; Voxtral Mini 3B,
  // empty or looping on many clips, no Thai.
  typhoon: [
    "run.py",
    "chayapats/typhoon-whisper-turbo-mlx",
    '{"language": "th", "groups": ["th", "mixed"], "processor": "typhoon-ai/typhoon-whisper-turbo"}',
  ],
  // SCB 10X's Thai fine-tune of Qwen3-ASR 0.6B (Sep 2026), on the Thai and mixed clips only. Its
  // weights are in transformers' layout: convert them once (local/convert_qwen3.py) into
  // STT_BENCH_MODELS/typhoon-ai/typhoon-asr-qwen-0.6b-ctx-mlx, with mlx-community's 0.6B build as base.
  "typhoon-qwen": [
    "run.py",
    "typhoon-ai/typhoon-asr-qwen-0.6b-ctx-mlx",
    '{"groups": ["th", "mixed"], "max_tokens": 2048}',
  ],
  whisper: [
    "run.py",
    "mlx-community/whisper-large-v3-turbo",
    '{"processor": "openai/whisper-large-v3-turbo"}',
  ],
};

async function run(cmd: string[], stdin?: Blob, env?: Record<string, string>) {
  const proc = Bun.spawn(cmd, {
    env: { ...process.env, ...env },
    stderr: "inherit",
    stdin: stdin ?? "inherit",
    stdout: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  if ((await proc.exited) !== 0) {
    throw new Error(`${cmd[0]} exited ${proc.exitCode}`);
  }
  return out;
}

const readJson = async <T>(path: string): Promise<T> =>
  JSON.parse(await Bun.file(path).text());

async function jobs() {
  const rows: Job[] = jobRows(ONLY_EN, ONLY_FR);
  await Bun.write(
    join(DIR, "jobs.jsonl"),
    `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`
  );
  console.log(`${rows.length} jobs`);
}

async function draw(seed?: string) {
  const all = (await Bun.file(join(DIR, "jobs.jsonl")).text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Job);
  const picks = sample(all, seed);
  await Bun.write(join(DIR, "sample.json"), JSON.stringify(picks, null, 1));
  console.log(`${picks.length} clips`);
}

// Scribe's words and the audio, from the archive.
async function clips() {
  await mkdir(CLIPS, { recursive: true });
  const picks = await readJson<Pick[]>(join(DIR, "sample.json"));
  const have = new Set(await readdir(CLIPS));
  // A redraw can move a clip to another group: the sample is the one source of its group, and the
  // runners read it from the clip's file.
  await Promise.all(
    picks
      .filter((p) => have.has(`${p.id}.json`))
      .map(async (p) => {
        const file = join(CLIPS, `${p.id}.json`);
        await Bun.write(
          file,
          JSON.stringify({ ...(await readJson<Clip>(file)), ...p })
        );
      })
  );
  const todo = picks.filter((p) => !have.has(`${p.id}.json`));
  const rows: { audio: string; id: string; words: Word[] }[] =
    todo.length > 0 ? storedWords(todo.map((p) => p.id)) : [];
  for (const [i, row] of rows.entries()) {
    const pick = todo.find((p) => p.id === row.id);
    if (!pick) {
      continue;
    }
    const ogg = join(CLIPS, `${row.id}.ogg`);
    // biome-ignore lint/performance/noAwaitInLoops: one clip after the other
    await Bun.write(ogg, Bun.file(row.audio));
    const seconds = Number(
      await run([
        "ffprobe",
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "csv=p=0",
        ogg,
      ])
    );
    const cut = window(row.words, seconds);
    await run([
      "ffmpeg",
      "-loglevel",
      "error",
      "-y",
      "-ss",
      String(cut.start),
      "-to",
      String(cut.end),
      "-i",
      ogg,
      "-ar",
      "16000",
      "-ac",
      "1",
      join(CLIPS, `${row.id}.wav`),
    ]);
    await Bun.file(ogg).delete();
    await Bun.write(
      join(CLIPS, `${row.id}.json`),
      JSON.stringify({ ...pick, ...cut })
    );
    console.log(`${i + 1}/${rows.length} clips`);
  }
}

// Every model unless named; a paid one (scribe.py: ElevenLabs credits) only when named.
async function models(names: string[]) {
  const free = Object.keys(MODELS).filter(
    (n) => MODELS[n]?.[0] !== "scribe.py"
  );
  for (const name of names.length > 0 ? names : free) {
    const [script, ...rest] = MODELS[name] ?? [];
    if (!script) {
      throw new Error(`unknown model ${name}: ${Object.keys(MODELS)}`);
    }
    console.log(name);
    const local = join(HERE, "../local");
    const path = join(local, script);
    // A script declaring its own dependencies (`# /// script`) runs in its own environment.
    // biome-ignore lint/performance/noAwaitInLoops: one model in memory at a time
    const own = (await Bun.file(path).text()).startsWith("# /// script");
    await run([
      "uv",
      "run",
      ...(own ? ["--script", path] : ["--project", local, "python", path]),
      ...rest.slice(0, 1),
      CLIPS,
      join(OUT, name),
      ...rest.slice(1),
    ]);
  }
}

const table = (head: string[], rows: string[][]) =>
  [
    `| ${head.join(" | ")} |`,
    `|${head.map(() => "---|").join("")}`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
  ].join("\n");

// Each model's output for each drawn clip it ran on.
async function loadOutputs() {
  const picks = await readJson<Pick[]>(join(DIR, "sample.json"));
  const clipList = await Promise.all(
    picks.map((p) => readJson<Clip>(join(CLIPS, `${p.id}.json`)))
  );
  const names = (await readdir(OUT).catch(() => [] as string[])).sort();
  const outputs = await Promise.all(
    names.map(async (name) => {
      const ran = await Promise.all(
        clipList.map(async (clip) => {
          const file = Bun.file(join(OUT, name, `${clip.id}.json`));
          return (await file.exists())
            ? [{ clip, out: JSON.parse(await file.text()) as Output }]
            : [];
        })
      );
      return { name, ran: ran.flat() };
    })
  );
  return { clipList, outputs };
}

async function score() {
  const { clipList, outputs } = await loadOutputs();
  const tallies = outputs.map(({ name, ran }) => ({ name, t: tally(ran) }));
  const rows = (
    keys: string[],
    extra: (t: ReturnType<typeof tally>) => string[] = () => []
  ) =>
    tallies
      .filter(({ t }) => keys.some((k) => t.has(k)))
      .map(({ name, t }) => [name, ...keys.map((k) => t.rate(k)), ...extra(t)]);
  const count = (g: Group) => clipList.filter((c) => c.group === g).length;
  const report = [
    "# Open models against Scribe",
    "",
    "Scribe's stored transcript is the reference, so every rate is distance from Scribe, not",
    "accuracy: a model that fixes Scribe's mistakes scores worse for it. Hesitations and stutters",
    "do not count. Speed is audio seconds per wall second.",
    "",
    `Clips: ${GROUPS.map((g) => `${g} ${count(g)}`).join(", ")}; ${clipList.filter((c) => c.several).length} with several speakers.`,
    "",
    "## Drift: words really different from Scribe's (English, French, and both in one clip)",
    "",
    "A word that is not small (de, the, à…) dropped, added or replaced by a word that is not a",
    "near-spelling, over Scribe's words that are not small.",
    "",
    table(
      ["model", "en", "fr", "fr+en"],
      rows(["drift en", "drift fr", "drift fr+en"])
    ),
    "",
    "## Text: word error rate (Thai by character)",
    "",
    table(
      ["model", ...GROUPS, "speed"],
      rows(
        GROUPS.map((g) => `text ${g}`),
        (t) => [t.speed]
      )
    ),
    "",
    "## Language: clips whose detected language differs from Scribe's",
    "",
    table(["model", "wrong"], rows(["language"])),
    "",
    "## Speakers: words credited to another speaker than Scribe's (clips with several)",
    "",
    table(
      ["model", "wrong", "speed"],
      rows(["speakers"], (t) => [t.speed])
    ),
  ].join("\n");
  await Bun.write(join(DIR, "report.md"), `${report}\n`);
  console.log(report);
}

// Every diarized Scribe job to the server, one at a time; a job with no turns keeps Scribe's speakers.
async function rediarize() {
  const dir = join(DIR, "resplit");
  const outcomes: Record<string, number> = {};
  for (const name of await readdir(dir)) {
    // biome-ignore lint/performance/noAwaitInLoops: one job at a time, the server's one writer
    const { turns } = (await Bun.file(join(dir, name)).json()) as {
      turns?: unknown[];
    };
    const status = turns?.length
      ? await fetch(
          `${process.env.LIFELOG_URL}/transcription-jobs/${name.replace(".json", "")}/speakers`,
          {
            body: JSON.stringify({ turns }),
            headers: {
              authorization: `Bearer ${process.env.LIFELOG_DEVICE_TOKEN}`,
              "content-type": "application/json",
            },
            method: "POST",
          }
        ).then(async (r) =>
          r.ok
            ? ((await r.json()) as { outcome: string }).outcome
            : `http ${r.status}`
        )
      : "no turns";
    outcomes[status] = (outcomes[status] ?? 0) + 1;
  }
  console.log(outcomes);
}

const [command, ...params] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  clips,
  context: () => (params[0] === "fit" ? fit(DIR) : context(DIR)),
  jobs,
  rediarize,
  run: () => models(params),
  sample: () => draw(params[0]),
  score,
};
const chosen = commands[command ?? ""];
if (!chosen) {
  throw new Error(`usage: bench ${Object.keys(commands).join(" | ")}`);
}
await mkdir(DIR, { recursive: true });
await chosen();
