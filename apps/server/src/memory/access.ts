import { join } from "node:path";
import { z } from "zod";
import { readJson } from "../core/files";
import { LIFE_STATE_DIR } from "../core/paths";
import { ACCESS_CHECKS, type AccessCheck } from "../records/integration";

// An access card's steps (`access`, the asks contract; his decision of 28 Nov 2026): what only he can grant on the Mac,
// each step with what Life checks silently (`ACCESS_CHECKS`, `records/integration.ts`). A step's status is worked out when
// read, from the Mac's statuses as last read (`ACCESS_STATUSES`, written whole by host's `readAccessNow` through the
// permissions helper: every grant is Life.app's), never stored on the card.

/** A step as Life sees it: `done`, `missing` (not asked yet, or not on yet), or `refused` (he said no to its prompt). */
export const AccessStatus = z.enum(["done", "missing", "refused"]);
type AccessStatus = z.infer<typeof AccessStatus>;

/** The Mac's statuses as last read: each check but `disk_free`, which is the free space against its step's own `freeGb`. */
export const AccessStatuses = z
  .object({
    freeGb: z.number().nonnegative().optional(),
    statuses: z.partialRecord(
      z.enum(ACCESS_CHECKS).exclude(["disk_free"]),
      AccessStatus
    ),
  })
  .strict();
export type AccessStatuses = z.infer<typeof AccessStatuses>;

/** Machine state, not memory: rewritten whole when it changes. */
export const ACCESS_STATUSES = join(LIFE_STATE_DIR, "access-statuses.json");

/** The Mac's statuses as last read; none read yet: every step missing. */
export const readAccessStatuses = (): AccessStatuses =>
  AccessStatuses.safeParse(readJson(ACCESS_STATUSES)).data ?? {
    statuses: {},
  };

/** An access need's step (`needs.ts`). */
interface AccessStep {
  check: AccessCheck;
  freeGb?: number;
  text: string;
}

const diskStatusOf = (free: number, needed: number): AccessStatus =>
  free >= needed ? "done" : "missing";

/** Each step with its status, worked out from `s`. */
export const accessStepsOf = (
  steps: readonly AccessStep[],
  s: AccessStatuses
) =>
  steps.map((step) => ({
    ...step,
    status:
      step.check === "disk_free"
        ? diskStatusOf(s.freeGb ?? 0, step.freeGb ?? 0)
        : (s.statuses[step.check] ?? ("missing" as AccessStatus)),
  }));

/** The first step not done, with its status; none when every step is done. */
export const nextAccessStepOf = (
  steps: readonly AccessStep[],
  s: AccessStatuses
) => accessStepsOf(steps, s).find((step) => step.status !== "done");

/** The steps numbered in plain words, a status after each one not missing: what a phone that doesn't know the kind draws. */
export const accessLineOf = (
  steps: readonly { status?: AccessStatus; text: string }[]
) =>
  steps
    .map(
      (step, i) =>
        `${i + 1}. ${step.text}${step.status && step.status !== "missing" ? ` (${step.status})` : ""}`
    )
    .join("\n");
