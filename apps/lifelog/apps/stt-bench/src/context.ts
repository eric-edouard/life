// The router on real blocks (`bench context`): blocks Scribe transcribed whole, heard again by the
// running speech service, each turn labelled Thai or not by Scribe's words, then routed by
// `routeTurns` with the zone the owner was in. `bench context fit` fits the router's weights.
// Everything it writes holds the owner's voice or words: in DIR/context, out of the repo.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { connect } from "@lifelog/db";
import { transcriptionJobs, transcripts } from "@lifelog/db/schema";
import { ownerZoneAt } from "@lifelog/server/src/diagnostics";
import {
  featuresOf,
  type Judged,
  judgedOf,
  routeTurns,
} from "@lifelog/server/src/route-turns";
import { Heard } from "@lifelog/server/src/speech-service";
import { and, eq, isNotNull } from "drizzle-orm";
import { pct, THAI } from "./score";

// A turn is Thai when at least this share of Scribe's words in it is in Thai script.
export const THAI_SHARE = 0.3;
// Blocks drawn of each kind of place (where Thai is spoken, elsewhere).
const PER_KIND = 175;
const HOME = "Asia/Bangkok";

function env(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`set ${name} as Lifelog Host's server.env does`);
  }
  return value;
}

export interface Row {
  day: string;
  features: number[];
  home: boolean;
  job: string;
  seconds: number;
  // Whether Scribe heard Thai in it; null when Scribe heard no words there.
  thai: boolean | null;
}
interface Block {
  heard: Heard;
  // Its turns of a second or more, in the order of `rows`.
  judged: Judged[];
  rows: Row[];
  zone: string;
}

// Thai by Scribe's words whose middle is in the turn.
export function thaiIn(
  turn: { end: number; start: number },
  words: { end: number; start: number; text: string }[]
) {
  const inside = words.filter((w) => {
    const middle = (w.start + w.end) / 2;
    return middle >= turn.start && middle < turn.end && w.text.trim() !== "";
  });
  const thai = inside.filter((w) => THAI.test(w.text)).length;
  return inside.length > 0 ? thai / inside.length >= THAI_SHARE : null;
}

// The drawn blocks: completed, transcribed by Scribe whole, with their audio, each with the zone he was
// in when it was recorded; those already heard first, then by id, so a run reuses what earlier ones heard.
function draw(dir: string) {
  const db = connect(env("DATABASE_PATH"), { readonly: true });
  try {
    const all = db
      .select({
        at: transcriptionJobs.captureStart,
        id: transcriptionJobs.id,
        key: transcriptionJobs.objectKey,
        words: transcripts.parsed,
      })
      .from(transcriptionJobs)
      .innerJoin(transcripts, eq(transcripts.jobId, transcriptionJobs.id))
      .where(
        and(
          eq(transcriptionJobs.state, "completed"),
          eq(transcriptionJobs.transcriber, "scribe"),
          isNotNull(transcriptionJobs.objectKey),
          isNotNull(transcriptionJobs.captureStart)
        )
      )
      .orderBy(transcriptionJobs.id)
      .all()
      .map((j) => ({ ...j, zone: ownerZoneAt(db, j.at ?? undefined) }));
    const heard = (id: string) => (existsSync(join(dir, `${id}.json`)) ? 0 : 1);
    const kind = (home: boolean) =>
      all
        .filter((j) => (j.zone === HOME) === home)
        .sort((a, b) => heard(a.id) - heard(b.id))
        .slice(0, PER_KIND);
    return [...kind(true), ...kind(false)];
  } finally {
    db.$client.close(true);
  }
}

// What the speech service heard in a block, cached by job (after a change to its models, delete
// context/heard to hear again). Without IDENTITY_URL, only the blocks already heard.
async function hear(dir: string, id: string, audio: string) {
  const file = Bun.file(join(dir, `${id}.json`));
  if (await file.exists()) {
    return Heard.parse(await file.json());
  }
  if (!process.env.IDENTITY_URL) {
    return null;
  }
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: the service hears one block at a time
    const res = await fetch(new URL("/transcribe", env("IDENTITY_URL")), {
      body: Bun.file(audio),
      headers: { "X-Identity-Secret": env("IDENTITY_SECRET") },
      method: "POST",
      signal: AbortSignal.timeout(600_000),
    });
    if (res.status === 503) {
      await Bun.sleep(5000);
      continue;
    }
    if (!res.ok) {
      return null;
    }
    const heard = Heard.parse(await res.json());
    await Bun.write(file, JSON.stringify(heard));
    return heard;
  }
}

async function blocks(DIR: string): Promise<Block[]> {
  const dir = join(DIR, "context", "heard");
  const out: Block[] = [];
  const drawn = draw(dir);
  for (const [i, j] of drawn.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: one block after the other
    const heard = await hear(dir, j.id, join(env("AUDIO_DIR"), j.key ?? ""));
    if (!heard) {
      continue; // not heard (no service, or it failed): counted by the blocks left out of the report
    }
    const day = j.at?.toISOString().slice(0, 10) ?? "";
    const judged = judgedOf(heard.turns);
    out.push({
      heard,
      judged,
      rows: judged.map((t) => ({
        day,
        features: featuresOf(t, judged, heard.words),
        home: j.zone === HOME,
        job: j.id,
        seconds: t.end - t.start,
        thai: thaiIn(t, j.words.words),
      })),
      zone: j.zone,
    });
    if ((i + 1) % 25 === 0) {
      console.log(`${i + 1}/${drawn.length} blocks`);
    }
  }
  return out;
}

// Thai missed and English or French sent, in seconds, and the share of speech sent to Scribe.
export function costs(rows: { row: Row; sent: boolean }[]) {
  const sum = (xs: typeof rows) => xs.reduce((s, x) => s + x.row.seconds, 0);
  const thai = rows.filter((x) => x.row.thai === true);
  const other = rows.filter((x) => x.row.thai === false);
  return {
    missed: pct(sum(thai.filter((x) => !x.sent)), sum(thai)),
    sent: pct(sum(other.filter((x) => x.sent)), sum(other)),
    toScribe: pct(sum(rows.filter((x) => x.sent)), sum(rows)),
  };
}

// Each turn as the router sends it, in the zone he was in or as if elsewhere.
function routed(b: Block, zone: string) {
  const route = routeTurns(b.heard, zone);
  return b.rows.map((row, i) => ({
    row,
    sent: route.kind === "whole" || route.routed.some((t) => t === b.judged[i]),
  }));
}

export async function context(DIR: string) {
  const all = await blocks(DIR);
  const home = all.filter((b) => b.zone === HOME);
  const line = (name: string, rows: { row: Row; sent: boolean }[]) => {
    const c = costs(rows);
    return `| ${name} | ${c.missed} | ${c.sent} | ${c.toScribe} |`;
  };
  const report = [
    "# The router on real blocks",
    "",
    `${all.length} blocks Scribe transcribed whole, ${all.reduce((s, b) => s + b.rows.length, 0)} turns of a second or more. A turn is Thai when ${THAI_SHARE * 100}% of Scribe's words in it are in Thai script.`,
    "",
    "| blocks | Thai missed | English or French sent | speech sent to Scribe |",
    "|---|---|---|---|",
    line(
      "where Thai is spoken",
      home.flatMap((b) => routed(b, b.zone))
    ),
    line(
      "elsewhere",
      all.filter((b) => b.zone !== HOME).flatMap((b) => routed(b, b.zone))
    ),
    line(
      "Thai-zone blocks as if elsewhere",
      home.flatMap((b) => routed(b, "UTC"))
    ),
  ].join("\n");
  await Bun.write(join(DIR, "context", "report.md"), `${report}\n`);
  console.log(report);
}

// A logistic regression, each class weighted to half, by gradient descent on standardized features;
// the weights come back in the features' own units.
export function fitLogistic(xs: number[][], ys: boolean[], steps = 3000) {
  const n = xs[0]?.length ?? 0;
  const col = (k: number) => xs.map((x) => x[k] ?? 0);
  const mean = Array.from(
    { length: n },
    (_, k) => col(k).reduce((sum, v) => sum + v, 0) / xs.length
  );
  const sd = mean.map(
    (m, k) =>
      Math.sqrt(col(k).reduce((sum, v) => sum + (v - m) ** 2, 0) / xs.length) ||
      1
  );
  const z = xs.map((x) => x.map((v, k) => (v - (mean[k] ?? 0)) / (sd[k] ?? 1)));
  const positives = ys.filter(Boolean).length;
  const weightOf = (y: boolean) =>
    xs.length / (2 * (y ? positives : xs.length - positives));
  let w = new Array<number>(n).fill(0);
  let b = 0;
  for (let step = 0; step < steps; step += 1) {
    const grad = new Array<number>(n).fill(0);
    let gb = 0;
    for (const [i, x] of z.entries()) {
      const p =
        1 / (1 + Math.exp(-x.reduce((s, v, k) => s + v * (w[k] ?? 0), b)));
      const e = (p - (ys[i] ? 1 : 0)) * weightOf(ys[i] ?? false);
      x.forEach((v, k) => {
        grad[k] = (grad[k] ?? 0) + e * v;
      });
      gb += e;
    }
    w = w.map((v, k) => v - (0.5 * (grad[k] ?? 0)) / xs.length);
    b -= (0.5 * gb) / xs.length;
  }
  const weights = w.map((v, k) => v / (sd[k] ?? 1));
  return {
    bias: b - weights.reduce((s, v, k) => s + v * (mean[k] ?? 0), 0),
    weights,
  };
}

const chance = (f: { bias: number; weights: number[] }, x: number[]) =>
  1 /
  (1 + Math.exp(-x.reduce((s, v, k) => s + v * (f.weights[k] ?? 0), f.bias)));

// Weights fitted on every labelled turn, scored on each day by a fit that left that day out.
export async function fit(DIR: string) {
  const rows = (await blocks(DIR)).flatMap((b) => b.rows);
  const labelled = rows.filter((r) => r.thai !== null);
  const days = [...new Set(labelled.map((r) => r.day))];
  const judged = days.flatMap((day) => {
    const f = fitLogistic(...unzip(labelled.filter((r) => r.day !== day)));
    return labelled
      .filter((r) => r.day === day)
      .map((row) => ({ p: chance(f, row.features), row }));
  });
  const at = (bar: number, home: boolean) =>
    costs(
      judged
        .filter((j) => j.row.home === home)
        .map((j) => ({
          row: j.row,
          sent: j.p >= bar,
        }))
    );
  const all = fitLogistic(...unzip(labelled));
  console.log(
    [
      `${labelled.length} turns over ${days.length} days, each day scored by a fit without it (turn by turn, before the whole-block rule):`,
      `where Thai is spoken, bar 0.3: ${JSON.stringify(at(0.3, true))}`,
      `elsewhere, bar 0.7: ${JSON.stringify(at(0.7, false))}`,
      `WEIGHTS = ${JSON.stringify(all.weights.map((w) => Number(w.toFixed(4))))}`,
      `BIAS = ${all.bias.toFixed(4)}`,
    ].join("\n")
  );
}

const unzip = (rows: Row[]): [number[][], boolean[]] => [
  rows.map((r) => r.features),
  rows.map((r) => r.thai === true),
];
