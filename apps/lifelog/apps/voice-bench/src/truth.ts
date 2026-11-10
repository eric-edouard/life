// Who spoke a turn, for the bench: the owner's answer in the bench's review (`answers.jsonl`, the
// bench's own file; `apply.ts` sends it to lifelog's server), else his answer in the archive.
import { appendFile } from "node:fs/promises";
import { clock } from "@life/server/src/core/clock";

// `unknown` is "nobody I know": mostly a voice he doesn't care about. `media` (a video, TV, noise)
// and `several` (several people in the clip) leave the scoring. `skipped` only leaves the
// review's queue.
export const ANSWER_KINDS = [
  "person",
  "unknown",
  "media",
  "several",
  "skipped",
] as const;

export interface BenchAnswer {
  at: string;
  id: string;
  kind: (typeof ANSWER_KINDS)[number];
  personId?: string;
}

export type Truth =
  | { kind: "person"; personId: string }
  | { kind: "unknown" }
  | { kind: "excluded" };

// The latest answer of each turn.
export const parseAnswers = (jsonl: string) =>
  new Map(
    jsonl
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as BenchAnswer)
      .map((a) => [a.id, a])
  );

export async function readAnswers(path: string) {
  const file = Bun.file(path);
  return parseAnswers((await file.exists()) ? await file.text() : "");
}

export const appendAnswer = (path: string, answer: Omit<BenchAnswer, "at">) =>
  appendFile(
    path,
    `${JSON.stringify({ ...answer, at: clock().toISOString() })}\n`
  );

// His answer in the archive (eval-voices `answers`): none when he never answered.
type ArchiveAnswer = { personId: string | null; status: string } | undefined;

export function truthOf(
  bench: BenchAnswer | undefined,
  archive: ArchiveAnswer
): Truth | undefined {
  if (bench && bench.kind !== "skipped") {
    if (bench.kind === "person") {
      return bench.personId
        ? { kind: "person", personId: bench.personId }
        : undefined;
    }
    return { kind: bench.kind === "unknown" ? "unknown" : "excluded" };
  }
  if (!archive) {
    return;
  }
  if (archive.personId) {
    return { kind: "person", personId: archive.personId };
  }
  return { kind: archive.status === "media" ? "excluded" : "unknown" };
}
