// ElevenLabs' credits as the job worker reads them: the plan's level, and the owner's email when they
// fall under 20 % and when they run out. Used up, nothing goes to ElevenLabs (it would answer 202 and
// never transcribe).
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { transcriptionJobs as jobs, waitsForCredits } from "@lifelog/db/schema";
import { emailOwner } from "./alert";
import { logChange } from "./change-log";
import type { Config } from "./config";
import { credits } from "./elevenlabs";
import { record } from "./events";

interface Credits {
  checkedAt: string;
  limit: number;
  used: number;
}

// Under 20 % of the plan left is "low"; the owner hears of it, and of "out", at most this often.
const CREDITS_LOW_SHARE = 0.2;
const CREDITS_ALERT_EVERY_MS = 12 * 3600 * 1000;
const CREDITS_EMAIL = {
  low: "ElevenLabs credits are under 20 %",
  out: "ElevenLabs credits are used up: what needs Scribe waits",
} as const;
const levelOf = (plan: Credits | null) => {
  if (!plan) {
    return "ok" as const;
  }
  if (plan.used >= plan.limit) {
    return "out" as const;
  }
  return plan.limit - plan.used < plan.limit * CREDITS_LOW_SHARE
    ? ("low" as const)
    : ("ok" as const);
};

export function creditsWatch(
  db: Db,
  config: Config,
  now = () => clock().getTime()
) {
  let plan: Credits | null = null;
  const alerted: Partial<Record<"low" | "out", number>> = {};

  // Reads the plan's credits; the owner gets an email when they fall under 20 % and when they
  // run out, at most once per 12 h each.
  async function check() {
    const read = await credits(config);
    if (!read) {
      return;
    }
    const before = levelOf(plan);
    plan = { ...read, checkedAt: new Date(now()).toISOString() };
    const level = levelOf(plan);
    if (level !== "out") {
      // The blocks waiting for credits go now (after a restart too).
      const due = db
        .update(jobs)
        .set({ error: null, nextAttemptAt: null })
        .where(waitsForCredits())
        .returning({ id: jobs.id })
        .all();
      logChange(
        db,
        "job",
        due.map((j) => j.id)
      );
    }
    if (level === before) {
      return;
    }
    record(db, "elevenlabs.quota", { level, ...read });
    if (
      level === "ok" ||
      now() - (alerted[level] ?? Number.NEGATIVE_INFINITY) <
        CREDITS_ALERT_EVERY_MS
    ) {
      return;
    }
    alerted[level] = now();
    const status = await emailOwner(config, {
      key: `credits-${level}-${Math.floor(now() / CREDITS_ALERT_EVERY_MS)}`,
      subject: `Lifelog: ${CREDITS_EMAIL[level]}`,
      text: `ElevenLabs: ${read.used} of ${read.limit} credits used. Used up, nothing goes to ElevenLabs until the plan is upgraded or renews: blocks the Mac transcribes alone still complete, the rest wait queued; nothing is lost.`,
    });
    record(db, "elevenlabs.quota_alert", { level, status });
  }

  return {
    check,
    level: () => levelOf(plan),
    read: () => plan,
  };
}
