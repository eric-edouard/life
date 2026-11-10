// Each drawn turn as a 16 kHz mono WAV, cut from its job's Ogg on the seconds production embeds.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "@life/server/src/core/proc";
import type { SampledTurn } from "./archive";

export const clipPath = (dir: string, id: string) =>
  join(dir, "clips", `${id}.wav`);

// One ffmpeg per job, a few at a time; a turn already cut is skipped. Returns the failures.
export async function cutClips(dir: string, turns: SampledTurn[]) {
  const jobs = [
    ...Map.groupBy(
      turns.filter((t) => !existsSync(clipPath(dir, t.id))),
      (t) => t.audio
    ),
  ];
  const failed: string[] = [];
  const cut = async ([audio, inJob]: (typeof jobs)[number]) => {
    const { code, stderr } = await exec([
      "ffmpeg",
      "-v",
      "error",
      "-y",
      "-i",
      audio,
      ...inJob.flatMap((t) => [
        "-ss",
        `${t.start}`,
        "-t",
        `${t.end - t.start}`,
        "-ar",
        "16000",
        "-ac",
        "1",
        clipPath(dir, t.id),
      ]),
    ]);
    if (code !== 0) {
      failed.push(`${audio}: ${stderr.trim().split("\n").at(-1)}`);
    }
  };
  // Eight at a time, each taking the next job when its own is cut.
  const queue = jobs.values();
  const next = async (): Promise<void> => {
    const job = queue.next();
    if (!job.done) {
      await cut(job.value);
      await next();
    }
  };
  await Promise.all(Array.from({ length: 8 }, next));
  return { cut: jobs.length, failed };
}
