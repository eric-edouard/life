// Apple's on-device model (Foundation Models), through the Mac app's helper (`LIFE_FOUNDATION_MODEL`,
// apps/mac/Sources/LifeFoundationModel): the one door to it, for the arrival reader. Never Private Cloud Compute. The
// helper knows no prompt: each request brings its instructions and the fields of its answer.

import { z } from "zod";
import { MIN } from "../core/clock";
import { timedLocalModel } from "../core/log";
import { exec } from "../core/proc";

/** One field of the answer: its name, what it holds, and the only values it may take, if any. */
export interface FoundationField {
  anyOf?: string[];
  description: string;
  name: string;
}

export interface FoundationRequest {
  fields: FoundationField[];
  instructions: string;
  text: string;
}

/** Apple's answer with the OS build that made it (a macOS update changes the model), or why there is none. */
export type FoundationAnswer =
  | { os: string; reply: Record<string, string> }
  | {
      detail: string;
      error: "failed" | "refused" | "unavailable" | "unsupported";
    };

const Line = z.union([
  z.object({ os: z.string(), reply: z.record(z.string(), z.string()) }),
  z.object({
    detail: z.string(),
    error: z.enum(["failed", "refused", "unavailable", "unsupported"]),
  }),
]);

const unavailable = (detail: string): FoundationAnswer => ({
  detail,
  error: "unavailable",
});

/**
 * Asks Apple's model, one spawn for all `requests`, answered in order, at background priority (`command`: the helper
 * under `taskpolicy -b`; a test passes its stub bare, free of the Mac's load). No helper (a checkout, Windows) or a helper
 * that fails answers every request `unavailable`: the caller's fallback, never a throw.
 */
export async function askFoundationModel(
  requests: FoundationRequest[],
  command = process.env.LIFE_FOUNDATION_MODEL
    ? ["taskpolicy", "-b", process.env.LIFE_FOUNDATION_MODEL]
    : []
): Promise<FoundationAnswer[]> {
  if (requests.length === 0) {
    return [];
  }
  if (command.length === 0) {
    return requests.map(() => unavailable("no helper (LIFE_FOUNDATION_MODEL)"));
  }
  return await timedLocalModel(
    "foundation",
    requests.length,
    async () =>
      answersOf(
        requests.length,
        await exec(command, {
          stdin: requests.map((q) => `${JSON.stringify(q)}\n`).join(""),
          timeout: requests.length * MIN,
        })
      ),
    // Answered: a reply for every request, whatever the helper's exit.
    (answers) => answers.every((a) => "reply" in a)
  );
}

/** The helper's lines, one per request in order; a missing or bad one is unavailable. */
function answersOf(
  count: number,
  r: { code: number; stderr: string; stdout: string }
): FoundationAnswer[] {
  const lines = r.stdout.split("\n").filter(Boolean);
  return Array.from({ length: count }, (_, i) => {
    const parsed = Line.safeParse(
      (() => {
        try {
          return JSON.parse(lines[i] ?? "null");
        } catch {
          return null;
        }
      })()
    );
    return parsed.success
      ? parsed.data
      : unavailable(`helper exited ${r.code}: ${r.stderr.trim().slice(-200)}`);
  });
}
