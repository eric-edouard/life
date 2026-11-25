import { z } from "zod";
import { clock, daysBefore, HOUR, iso } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { ownerStateNow } from "../host/owner-state";
import type { Instruction } from "../memory/instructions";
import { begin, readsOf } from "../memory/run";
import { dayNow, dayStart, zoneNow } from "../memory/zones";

// The gate on every agent's card (the v4 plan, verdict 1, bundle E): one model call with no tools, on the agents' own
// model, reads the card as he would see it with what he is doing now (`ownerStateNow`) and returns four readings;
// code alone turns them into deliver, hold or send back, inside fixed limits (`gateVerdictOf`). Those limits, and
// failing open, are the safety: a model can't talk a card past them.

export const GATE_PROMPT = "desk-gate.v1";
/** A call that takes longer lets the card through. */
const GATE_WITHIN_MS = 10_000;
/** The longest hold, and how near its deadline a card is never held. */
const MAX_HOLD = 12 * HOUR;
const DEADLINE_MARGIN = 3 * HOUR;
/** How long a card is held for a better moment, by its urgency (high never waits). */
const HOLD_FOR = { low: MAX_HOLD, normal: 3 * HOUR } as const;

const Level = z.enum(["low", "normal", "high"]);
export const GateReadings = z.object({
  canActNow: z.boolean(),
  goodMoment: z.boolean(),
  importance: Level,
  sendBack: z.string().min(1).max(600).nullable().default(null),
  sensitive: z.boolean().default(false),
  urgency: Level,
});
export type GateReadings = z.infer<typeof GateReadings>;

/** What code decides; `rules` are the limits and effects that decided it, kept as a record only. */
export type GateVerdict = { rules: string[] } & (
  | { silent?: true; verdict: "deliver" }
  | { until: string; verdict: "hold" }
  | { note: string; verdict: "send-back" }
);

/** What the verdict rests on beside the readings: the card's deadline and his instructions' effects on it. */
export interface GateFacts {
  /** The next of his `batch` moments, when one holds on it. */
  batchAt?: number;
  deadline: string;
  /** `interrupt` (pass) or `quiet` (hold) in force on it; a refusal beats a grant. */
  effect?: "interrupt" | "quiet";
  now: Date;
  /** Null: the call failed or was late, so the card goes through. */
  readings: GateReadings | null;
  /** A card of the same work was already sent back once: never again. */
  wasSentBack: boolean;
}

/**
 * Deliver, hold or send back, the one rule (pure): a failed call delivers; a send-back (asked for, or a sensitive
 * subject) only once per piece of work, a sensitive card then delivered with no push; `interrupt` delivers; `quiet`,
 * a `batch` moment ahead, or not a good moment (or not one he can act in) holds, unless urgency is high. A hold lasts
 * 12 hours at most (or to the batch moment), never into the 3 hours before the deadline; one that would end now delivers.
 */
export function gateVerdictOf(f: GateFacts): GateVerdict {
  const r = f.readings;
  if (!r) {
    return { rules: ["failed open"], verdict: "deliver" };
  }
  const note =
    r.sendBack ??
    (r.sensitive
      ? "This touches a subject he asked never to be brought up: leave it out, or don't ask."
      : null);
  if (note && !f.wasSentBack) {
    return { note, rules: ["sent back once"], verdict: "send-back" };
  }
  if (r.sensitive) {
    return { rules: ["sensitive: no push"], silent: true, verdict: "deliver" };
  }
  if (f.effect === "interrupt" || r.urgency === "high") {
    return {
      rules: [f.effect === "interrupt" ? "interrupt" : "urgent"],
      verdict: "deliver",
    };
  }
  const now = f.now.getTime();
  const latest = Date.parse(f.deadline) - DEADLINE_MARGIN;
  const wanted = [
    ...(f.batchAt === undefined ? [] : [{ at: f.batchAt, rule: "batch" }]),
    ...(f.effect === "quiet" ? [{ at: now + MAX_HOLD, rule: "quiet" }] : []),
    ...(r.goodMoment && r.canActNow
      ? []
      : [{ at: now + HOLD_FOR[r.urgency], rule: "not now" }]),
  ];
  if (wanted.length === 0) {
    return { rules: ["good moment"], verdict: "deliver" };
  }
  // 12 hours at most, or to his next batch moment when one holds on it.
  const cap = Math.max(now + MAX_HOLD, f.batchAt ?? 0);
  const until = Math.min(Math.max(...wanted.map((w) => w.at)), cap, latest);
  const rules = wanted.map((w) => w.rule);
  return until <= now
    ? { rules: [...rules, "deadline near"], verdict: "deliver" }
    : { rules, until: iso(until), verdict: "hold" };
}

const HM = /\b([01]?\d|2[0-3])[:h]([0-5]\d)\b/g;

/** The next of the moments a `batch` instruction names ("9:00 and 18:00") after `now`, in his zone; none named, none. */
export function nextBatchAtOf(text: string, now: Date, zone = zoneNow()) {
  const moments = [...text.matchAll(HM)].map(
    ([, h = "0", m = "0"]) => `${h.padStart(2, "0")}:${m}`
  );
  const today = dayNow(now);
  const at = [today, daysBefore(today, -1)]
    .flatMap((day) => moments.map((hm) => dayStart(day, zone, hm).getTime()))
    .filter((t) => t > now.getTime());
  return at.length > 0 ? Math.min(...at) : undefined;
}

/** What of his instructions in force on a card the gate's code enforces: `interrupt` or `quiet` (a refusal beats a grant), and the next `batch` moment. */
export function effectsOf(list: readonly Instruction[], now: Date) {
  const has = (e: string) => list.some((i) => i.effect === e);
  const batch = list.find((i) => i.effect === "batch");
  let effect: GateFacts["effect"];
  if (has("quiet")) {
    effect = "quiet";
  } else if (has("interrupt")) {
    effect = "interrupt";
  }
  return {
    batchAt: batch ? nextBatchAtOf(batch.text, now) : undefined,
    effect,
  };
}

/** A card as the gate reads it: what his phone shows of it. */
export interface GateCard {
  ask?: string;
  context: string;
  deadline: string;
  draft?: { text?: string; to: string };
  id: string;
  options: { id: string; label: string }[];
  question: string;
  recommended?: string;
  title: string;
}

/** The four readings of `card` now, or null when the call failed or took over 10 seconds (the card goes through). */
export async function readGate(
  card: GateCard,
  instructions: readonly Instruction[],
  waiting: number
): Promise<GateReadings | null> {
  try {
    const step = await begin(
      "desk-gate",
      "deep",
      { card: card.id },
      "openrouter"
    );
    const input = {
      card: {
        ask: card.ask,
        context: card.context.slice(0, 1200),
        deadline: card.deadline,
        draft: card.draft,
        options: card.options.map((o) => o.label),
        question: card.question,
        recommended: card.options.find((o) => o.id === card.recommended)?.label,
        title: card.title,
      },
      instructions: instructions.map((i) => ({
        effect: i.effect ?? null,
        text: i.text,
      })),
      now: clock().toISOString(),
      state: await ownerStateNow(),
      waiting,
    };
    const reply = await Promise.race([
      step.ask({
        dir: step.dir,
        input,
        prompt: GATE_PROMPT,
        reads: readsOf([{ source: "memory", unit: card.id }]),
      }),
      Bun.sleep(GATE_WITHIN_MS).then(() => {
        throw new Error("the gate took over 10 seconds");
      }),
    ]);
    step.end({});
    return GateReadings.parse(reply);
  } catch (e) {
    log("run.error", { ...errorOf(e), card: card.id, step: "desk.gate" });
    return null;
  }
}
