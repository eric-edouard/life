// The transcription bench: Scribe's stored transcripts against open models run on this Mac.
// Everything it reads or writes holds the owner's voice or words and stays in DIR, out of the repo.
//   bun run bench jobs            the server's completed jobs, no text (jobs.jsonl)
//   bun run bench sample [seed]   the stratified draw (sample.json)
//   bun run bench clips           each drawn job's audio window (.wav) and Scribe's words in it
//   bun run bench run [model…]    the open models over every clip (out/<model>/), all by default
//   bun run bench score           text, language and speakers of each model against Scribe (report.md)
//   bun run bench route [diarizer] how well each detector finds the Thai on that diarizer's turns
//                                 (routing/<diarizer>/routing.md; pyannote by default)
//   bun run bench pipeline [thai] the proposed pipeline (Ultra, a Thai model on routed turns) as a model
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Word } from "@lifelog/db/schema";
import { jobRows, storedWords } from "./export";
import {
  compose,
  heardIn,
  type Judged,
  routed,
  routingErrors,
  segments,
  silent,
  THAI_SHARE,
} from "./routing";
import {
  GROUPS,
  type Group,
  type Job,
  type Pick,
  sample,
  window,
} from "./sample";
import {
  type Clip,
  ONLY_EN,
  ONLY_FR,
  type Output,
  pct,
  tally,
  turnsOf,
} from "./score";

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

// Routing: each clip cut into speaker turns (a diarizer's), each turn labelled by Scribe's Thai, then
// judged by what Parakeet Ultra heard and by an audio language detector (local/lid.py). Each
// diarizer's turns and guesses are kept apart, in routing/<diarizer>.
const routingDir = (diarizer: string) => join(DIR, "routing", diarizer);
// The diarizer `route` judges by default and the pipeline was scored on.
const DIARIZER = "pyannote";
// Every speaker turn of every clip, labelled by Scribe's Thai, with what Parakeet Ultra heard and
// VoxLingua107's guess (on the audio, cached in the diarizer's routing folder).
async function judge(diarizer: string) {
  const { clipList, outputs } = await loadOutputs();
  if (!outputs.some((o) => o.name === diarizer)) {
    throw new Error(`no run of ${diarizer}: bench run ${diarizer} first`);
  }
  const ROUTING = routingDir(diarizer);
  await mkdir(ROUTING, { recursive: true });
  const outOf = (name: string, id: string) =>
    outputs.find((o) => o.name === name)?.ran.find((r) => r.clip.id === id)
      ?.out;
  const tokensOf = (out: Output | undefined) =>
    (out?.segments ?? []).flatMap(
      (s) => (s.tokens ?? []) as { end: number; start: number; text: string }[]
    );
  const all: Judged[] = clipList.flatMap((clip) =>
    segments(
      turnsOf(outOf(diarizer, clip.id) ?? { wallSeconds: 0 }) ?? [],
      clip.words
    ).map((s) => ({
      ...s,
      clip: clip.id,
      heard: heardIn(tokensOf(outOf("parakeet-ultra", clip.id)), s),
    }))
  );
  await guessLanguages(ROUTING, all);
  return { all, clipList, outputs, ROUTING, tokensOf };
}

// VoxLingua107's guess for each turn (local/lid.py), run once and cached in the routing folder.
async function guessLanguages(ROUTING: string, all: Judged[]) {
  const audioFile = join(ROUTING, "audio.json");
  if (!(await Bun.file(audioFile).exists())) {
    const input = join(ROUTING, "segments.json");
    await Bun.write(
      input,
      JSON.stringify(all.map(({ clip, end, start }) => ({ clip, end, start })))
    );
    const local = join(HERE, "../local");
    await run([
      "uv",
      "run",
      "--project",
      local,
      "python",
      join(local, "lid.py"),
      CLIPS,
      input,
      audioFile,
    ]);
  }
  // Matched by clip and start: after a changed diarization, delete audio.json to guess again.
  const guess = new Map(
    (await readJson<Judged[]>(audioFile)).map((a) => [
      `${a.clip} ${a.start}`,
      a.voxlingua,
    ])
  );
  for (const s of all) {
    const voxlingua = guess.get(`${s.clip} ${s.start}`);
    if (!voxlingua) {
      throw new Error(
        `${audioFile} has no guess for a turn: delete it to guess again`
      );
    }
    s.voxlingua = voxlingua;
  }
}

async function route(diarizer = DIARIZER) {
  const { all, ROUTING } = await judge(diarizer);
  const thaiProb = (s: Judged) => s.voxlingua?.thai ?? 0;
  // The rule before 24 Oct, measured beside the one routed now (VoxLingua107 hears Thai).
  const neither = (s: Judged) =>
    !["en", "fr"].includes(s.voxlingua?.lang ?? "en");
  const rules: [string, (s: Judged) => boolean][] = [
    ["VoxLingua107: Thai likelier than not", (s) => thaiProb(s) >= 0.5],
    ["VoxLingua107: Thai (routed)", routed],
    ["VoxLingua107: neither English nor French", neither],
    ["Parakeet Ultra wrote nothing", silent],
    [
      "VoxLingua107 neither English nor French, or Ultra wrote nothing (before 24 Oct)",
      (s) => neither(s) || silent(s),
    ],
  ];

  const labelled = all.filter((s) => s.thai !== null);
  const rows = rules.map(([name, flag]) => {
    const e = routingErrors(
      labelled.map((segment) => ({ flagged: flag(segment), segment }))
    );
    return [name, pct(e.missed, 1), pct(e.falseAlarms, 1)];
  });
  const thaiSegments = labelled.filter((s) => s.thai).length;
  const report = [
    "# Language routing: finding the Thai",
    "",
    `${labelled.length} speaker turns of a second or more, ${thaiSegments} of them Thai by Scribe's words (at least ${THAI_SHARE * 100}% in Thai script). Missed: seconds of Thai left with the English and French model. False alarms: seconds of English or French sent to the Thai one.`,
    "",
    table(["detector", "missed Thai", "false alarms"], rows),
  ].join("\n");
  await Bun.write(join(ROUTING, "routing.md"), `${report}\n`);
  console.log(report);
}

// The proposed pipeline, scored like any model (out/pipeline). A block whose speech is mostly Thai
// goes whole to the Thai model, which needs the context (Qwen3: Thai 26% from
// Scribe, against 40% turn by turn); any other block is Parakeet Ultra's words, except in the turns
// the router sends away, where the Thai model run on those turns alone takes over (Qwen3: Thai with
// English 29%). Chosen on 16 Thai clips: the 70% is a first cut, not a tuned value. The Thai model is
// Qwen3 unless named (`bench pipeline typhoon`: out/pipeline-typhoon); it gets every routed turn,
// English and French ones sent by mistake included, whatever groups it is otherwise run on. Its
// turns are DIARIZER's, as scored.
async function pipeline(thai = "qwen3") {
  const [script, id, options] = MODELS[thai] ?? [];
  if (!(script && id)) {
    throw new Error(`${thai} is not in MODELS`);
  }
  const { all, clipList, outputs, ROUTING, tokensOf } = await judge(DIARIZER);
  const outOf = (model: string, clip: string) =>
    outputs.find((o) => o.name === model)?.ran.find((r) => r.clip.id === clip)
      ?.out;
  // An mlx-audio model is run again on the routed turns alone; any other (Scribe, paid) gives timed
  // words over the clips it ran on, of which the pipeline takes those inside the routed turns.
  const heardOf =
    script === "run.py"
      ? await rerun(thai, id, options, all, ROUTING)
      : async (clip: string) => outOf(thai, clip);
  const name = thai === "qwen3" ? "pipeline" : `pipeline-${thai}`;
  await mkdir(join(OUT, name), { recursive: true });
  for (const clip of clipList) {
    // biome-ignore lint/performance/noAwaitInLoops: one small file per clip
    const heard = await heardOf(clip.id);
    const whole = outOf(thai, clip.id);
    if (heard === undefined) {
      continue; // a paid model ran on some clips only: its pipeline is scored on those
    }
    const ultra = outOf("parakeet-ultra", clip.id);
    const text = compose({
      heard,
      mine: all.filter((t) => t.clip === clip.id),
      timed: heard === whole,
      ultra: tokensOf(ultra),
      whole,
    });
    const used = text === whole?.text ? whole : heard;
    await Bun.write(
      join(OUT, name, `${clip.id}.json`),
      JSON.stringify({
        text,
        wallSeconds: (ultra?.wallSeconds ?? 0) + (used?.wallSeconds ?? 0),
      })
    );
  }
  console.log(
    `${all.filter(routed).length} turns sent to ${thai} of ${all.length}`
  );
}

// Runs an mlx-audio model on the routed turns alone; what it heard in a clip, null for a clip with
// none.
async function rerun(
  thai: string,
  id: string,
  options: string | undefined,
  all: Judged[],
  ROUTING: string
) {
  const away = Map.groupBy(all.filter(routed), (s) => s.clip);
  const turnsFile = join(ROUTING, "turns.json");
  await Bun.write(
    turnsFile,
    JSON.stringify(
      Object.fromEntries(
        [...away].map(([clip, ts]) => [clip, ts.map((t) => [t.start, t.end])])
      )
    )
  );
  const { groups: _, ...args } = JSON.parse(options ?? "{}");
  const turnsDir = join(ROUTING, `${thai}-turns`);
  const local = join(HERE, "../local");
  await run([
    "uv",
    "run",
    "--project",
    local,
    "python",
    join(local, "run.py"),
    id,
    CLIPS,
    turnsDir,
    JSON.stringify({ ...args, turns: turnsFile }),
  ]);
  return async (clip: string): Promise<Output | null> => {
    const file = Bun.file(join(turnsDir, `${clip}.json`));
    return (await file.exists()) ? ((await file.json()) as Output) : null;
  };
}

const [command, ...params] = process.argv.slice(2);
const commands: Record<string, () => Promise<void>> = {
  clips,
  jobs,
  pipeline: () => pipeline(params[0]),
  route: () => route(params[0]),
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
