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

// An answer of his, the bench's or the archive's, as one shape.
export type Name = Pick<BenchAnswer, "personId"> & {
  kind: Exclude<BenchAnswer["kind"], "skipped">;
};

// His answer in the archive, read from its owner row: none when he never answered.
export const nameOf = (
  row:
    | { candidates?: unknown; personId: string | null; status: string }
    | undefined
): Name | undefined => {
  if (!row) {
    return;
  }
  if (row.candidates) {
    return { kind: "several" };
  }
  if (row.status === "not_relevant") {
    return; // Maybe someone he knows, unnamed: no answer to score.
  }
  return row.personId
    ? { kind: "person", personId: row.personId }
    : { kind: row.status === "media" ? "media" : "unknown" };
};

export function truthOf(
  bench: BenchAnswer | undefined,
  archive: Parameters<typeof nameOf>[0]
): Truth | undefined {
  const name = bench && bench.kind !== "skipped" ? bench : nameOf(archive);
  if (!name) {
    return;
  }
  if (name.kind === "person") {
    return name.personId
      ? { kind: "person", personId: name.personId }
      : undefined;
  }
  return { kind: name.kind === "unknown" ? "unknown" : "excluded" };
}
