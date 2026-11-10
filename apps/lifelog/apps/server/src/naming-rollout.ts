import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { namingAttempts, namingRollout } from "@lifelog/db/schema";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { NAMING } from "./config";
import {
  isNamingGate,
  namingPolicyHashOf,
  namingPromptHash,
} from "./inferred-speakers";
import { subscriptions } from "./subscriptions";
export type Rollout = typeof namingRollout.$inferSelect;
export const rolloutWhere = (
  key: Pick<Rollout, "model" | "promptHash" | "policyHash">
) =>
  and(
    eq(namingRollout.model, key.model),
    eq(namingRollout.promptHash, key.promptHash),
    eq(namingRollout.policyHash, key.policyHash)
  );
// Only an offline scorer's bound receipt may open the gate; this never runs a measurement.
export function storeNamingGate(db: Db, receipt: unknown, model: string) {
  if (!isNamingGate(receipt, model)) {
    return false;
  }
  const policyHash = namingPolicyHashOf();
  db.insert(namingRollout)
    .values({
      gate: receipt,
      model,
      policyHash,
      promptHash: namingPromptHash(),
    })
    .onConflictDoUpdate({
      set: { gate: receipt },
      target: [
        namingRollout.model,
        namingRollout.promptHash,
        namingRollout.policyHash,
      ],
    })
    .run();
  return true;
}

// Both measured subscription windows constrain sustainable archive throughput.
export function namingPilotPace(
  rollout: Rollout,
  now = clock().getTime(),
  usage?: {
    fiveHour: { resetsAt: number; usedPercent: number };
    sevenDay: { resetsAt: number; usedPercent: number };
  }
) {
  if (
    rollout.pilotCalls !== NAMING.pilotMaxCalls ||
    !rollout.inputTokens ||
    !rollout.latencyMs
  ) {
    return null;
  }
  let pace = rollout.latencyMs / rollout.pilotCalls;
  for (const [raw, fresh] of [
    [rollout.shortWindow, usage?.fiveHour],
    [rollout.longWindow, usage?.sevenDay],
  ] as const) {
    const pair = z
      .object({
        after: z.object({ resetsAt: z.number(), usedPercent: z.number() }),
        before: z.object({ resetsAt: z.number(), usedPercent: z.number() }),
      })
      .safeParse(raw).data;
    if (
      !pair ||
      pair.before.resetsAt !== pair.after.resetsAt ||
      pair.after.usedPercent <= pair.before.usedPercent ||
      (fresh ?? pair.after).resetsAt * 1000 <= now ||
      (fresh ?? pair.after).usedPercent >= NAMING.quotaMaxPercent
    ) {
      return null;
    }
    pace = Math.max(
      pace,
      (((fresh ?? pair.after).resetsAt * 1000 - now) *
        (pair.after.usedPercent - pair.before.usedPercent)) /
        (rollout.pilotCalls *
          (NAMING.quotaMaxPercent - (fresh ?? pair.after).usedPercent))
    );
  }
  return pace;
}
export function finishNamingPilot(db: Db, rollout: Rollout) {
  const usage = namingQuota(db);
  if (!usage) {
    return rollout;
  }
  const calls = db
    .select()
    .from(namingAttempts)
    .where(
      and(
        eq(namingAttempts.policyHash, rollout.policyHash),
        eq(namingAttempts.model, rollout.model),
        eq(namingAttempts.promptHash, rollout.promptHash)
      )
    )
    .all()
    .flatMap(
      (a) =>
        (
          a.call as {
            history?: { pilot: boolean; valid: boolean; completedAt: number }[];
          } | null
        )?.history ?? []
    )
    .filter((c) => c.pilot);
  if (
    calls.some(
      (c) =>
        !Number.isFinite(c.completedAt) ||
        usage.observedAt * 1000 <= c.completedAt
    )
  ) {
    return rollout;
  }
  const updated = {
    ...rollout,
    longWindow: {
      ...(rollout.longWindow as object),
      after: { ...usage.sevenDay, observedAt: usage.observedAt },
    },
    shortWindow: {
      ...(rollout.shortWindow as object),
      after: { ...usage.fiveHour, observedAt: usage.observedAt },
    },
  };
  updated.pilotPassed =
    calls.length === NAMING.pilotMaxCalls &&
    calls.some((c) => c.valid) &&
    namingPilotPace(updated) !== null;
  db.update(namingRollout)
    .set({
      longWindow: updated.longWindow,
      pilotPassed: updated.pilotPassed,
      shortWindow: updated.shortWindow,
    })
    .where(rolloutWhere(rollout))
    .run();
  return updated;
}

export function namingQuota(db: Db, now = clock().getTime()) {
  const usage = subscriptions(db).codex;
  if (
    !usage ||
    now / 1000 < usage.observedAt ||
    now - usage.observedAt * 1000 > NAMING.quotaMaxAgeMs
  ) {
    return null;
  }
  if (
    !(
      usage.fiveHour &&
      usage.sevenDay &&
      [usage.fiveHour, usage.sevenDay].every(
        (window) =>
          window.resetsAt * 1000 > now &&
          window.usedPercent < NAMING.quotaMaxPercent
      )
    )
  ) {
    return null;
  }
  return { ...usage, fiveHour: usage.fiveHour, sevenDay: usage.sevenDay };
}
