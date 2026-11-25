import { z } from "zod";
import { clock, daysBefore, HOUR, iso } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { cardInstructionsOf } from "../host/card-push";
import { assignmentOfCard, lastTurns } from "../host/desk-read";
import { appOpenSinceOf, ownerStateNow } from "../host/owner-state";
import { endLatersAtHome } from "../memory/arrival-home";
import { deliveryOf, recordDelivered } from "../memory/decision-delivery";
import type { Decision } from "../memory/decision-lines";
import { decisionsNow } from "../memory/decisions";
import { draftWords, type StoredDraft } from "../memory/draft";
import { readExchangeCounts, replyHourOf } from "../memory/exchange-counts";
import type { instructionsFor } from "../memory/instructions";
import { OWNER } from "../memory/read-truth";
import { begin, readsOf } from "../memory/run";
import { dayNow, dayStart, zoneNow } from "../memory/zones";
import { MAIN_QUESTION } from "./agent-questions";
import type { Desk } from "./desk-store";
import { queue } from "./event-queue";
import { MAIN_ASK } from "./main-session";

type Instruction = ReturnType<typeof instructionsFor>[number];

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
/** How long a card is held for a better moment, by its urgency (high waits only under his `quiet`). */
const HOLD_FOR = { high: 3 * HOUR, low: MAX_HOLD, normal: 3 * HOUR } as const;

const Level = z.enum(["low", "normal", "high"]);
export const GateReadings = z.object({
  canActNow: z.boolean(),
  goodMoment: z.boolean(),
  importance: Level,
  sendBack: z.string().min(1).max(500).nullable().default(null),
  sensitive: z.boolean().default(false),
  urgency: Level,
});
export type GateReadings = z.infer<typeof GateReadings>;

/** What code decides; `rules` are the limits and effects that decided it, kept as a record only. */
export type GateVerdict = { rules: string[] } & (
  | { silent?: true; verdict: "deliver" }
  | { until: string; verdict: "hold" }
  | { note: string; verdict: "send_back" }
);

/** What the verdict rests on beside the readings: the card's deadline and his instructions' effects on it. */
export interface GateFacts {
  /** The next of his `batch` moments, when one holds on it. */
  batchAt?: number;
  deadline: string;
  /** `interrupt` (pass) or `quiet` (hold) in force on it; a refusal beats a grant. */
  effect?: "interrupt" | "quiet";
  /** Life's app is open in his hand (`appOpenSinceOf`): now is free, never "not now". */
  isAppOpen?: boolean;
  now: Date;
  /** Null: the call failed or was late, so the card goes through. */
  readings: GateReadings | null;
  /** A draft's: the next of his usual reply hours in its chat (`replyAtOf`), when he answers it in batches. */
  replyAt?: number;
  /** A card of the same work was already sent back once: never again. */
  wasSentBack: boolean;
}

/**
 * Deliver, hold or send back, the one rule (pure): a failed call delivers; a send-back (asked for, or a sensitive
 * subject) only once per piece of work, a sensitive card then delivered with no push; `interrupt` delivers; `quiet`,
 * a `batch` moment ahead, his usual reply hour in a draft's chat within 12 hours, or not a good moment (or not one he can
 * act in, and Life's app not open) holds, unless urgency is high. A hold lasts
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
    return { note, rules: ["sent back once"], verdict: "send_back" };
  }
  if (r.sensitive) {
    return { rules: ["sensitive: no push"], silent: true, verdict: "deliver" };
  }
  // His `quiet` beats the model's urgency: only a near deadline (below) lets such a card through.
  if (
    f.effect === "interrupt" ||
    (r.urgency === "high" && f.effect !== "quiet")
  ) {
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
    ...(f.replyAt !== undefined && f.replyAt - now <= MAX_HOLD
      ? [{ at: f.replyAt, rule: "reply time" }]
      : []),
    ...((r.goodMoment && r.canActNow) || f.isAppOpen
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

/**
 * The next instant of his usual reply hour (`replyHourOf`) in a draft's 1:1 chat, after `now`, where he is; none for a
 * group, a new chat, or a person he answers at once. The person is the other sender of its last messages.
 */
export function replyAtOf(
  draft: StoredDraft | undefined,
  now: Date,
  // Read only for a 1:1 draft: the file is a few MB.
  counted = readExchangeCounts
) {
  const ref =
    draft && !draft.people
      ? draft.recent?.find((m) => m.sender.ref !== OWNER)?.sender.ref
      : undefined;
  const hour = ref ? replyHourOf(counted()?.people[ref] ?? [], now) : undefined;
  if (hour === undefined) {
    return;
  }
  const hm = `${String(hour).padStart(2, "0")}:00`;
  const today = dayNow(now);
  return [today, daysBefore(today, -1)]
    .map((day) => dayStart(day, zoneNow(), hm).getTime())
    .find((t) => t > now.getTime());
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
  let step: Awaited<ReturnType<typeof begin>> | undefined;
  try {
    step = await begin("desk-gate", "deep", { card: card.id }, "openrouter");
    const run = step;
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
      run.ask({
        dir: run.dir,
        input,
        prompt: GATE_PROMPT,
        reads: readsOf([{ source: "memory", unit: card.id }]),
      }),
      Bun.sleep(GATE_WITHIN_MS).then(() => {
        throw new Error("the gate took over 10 seconds");
      }),
    ]);
    step.end({ ok: 1 });
    return GateReadings.parse(reply);
  } catch (e) {
    log("run.error", { ...errorOf(e), card: card.id, step: "desk.gate" });
    // Its run is closed too (a late call still logs its own `model.run` line when it ends).
    step?.end({ ok: 0 });
    return null;
  }
}

/** How many cards the gate reads in one tick, so a backlog never holds the desk's tick past its hang guard. */
const PER_TICK = 10;

/** The event a card sent back wakes its agent with: the card's id only; the agent reads the gate's note at its door. */
export const SENT_BACK = "decision.sent_back";
/** The turns whose cards follow what he just did (his answer, his question, his ask): never gated. */
const FOLLOW_UP_CAUSES = new Set(["answer", MAIN_QUESTION, MAIN_ASK]);

/** Whether card `d` was asked in a turn that follows what he just did (its assignment's turn running when it was asked). */
function isFollowUpOf(db: Desk["db"], d: Decision) {
  const assignment = assignmentOfCard(db, d);
  const turn =
    assignment &&
    lastTurns(db, assignment, 20).find(
      (t) => t.started_at <= d.at && (!t.ended_at || t.ended_at >= d.at)
    );
  return Boolean(turn && FOLLOW_UP_CAUSES.has(turn.cause));
}

/** The card as his phone shows it. */
const gateCardOf = (d: Decision): GateCard => ({
  ask: d.ask,
  context: d.context,
  deadline: d.deadline,
  ...(d.draft
    ? { draft: { text: draftWords(d.draft).join("\n"), to: d.draft.to } }
    : {}),
  id: d.id,
  options: d.options,
  question: d.question,
  recommended: d.recommended,
  title: d.title,
});

/**
 * The gate's step of the desk's tick: each agent's card not gated yet (`deliveryOf` pending) gets its verdict, one
 * `delivered` line (`recordDelivered`); a follow-up to what he just did is delivered unread. First, his Laters that wait
 * for home end once he got there. A card sent back wakes its
 * agent (`SENT_BACK`, facts only). A hold ends by itself at its time (`deliveryOf`). One card at a time.
 */
export async function gateCards(desk: Desk, now = clock()) {
  // His Laters that wait for home end at his arrival there (`endLatersAtHome`): the card is his again.
  await endLatersAtHome(now);
  const all = decisionsNow(now);
  const pending = all.filter(
    (d) => d.state === "open" && deliveryOf(d, now).state === "pending"
  );
  const waiting = all.filter(
    (d) => d.state === "open" && deliveryOf(d, now).state === "delivered"
  ).length;
  // At most `PER_TICK` a tick: the rest wait for the next one (past `PENDING_FOR` they count as delivered).
  for (const d of pending.slice(0, PER_TICK)) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one call a card, in order
      await gateCard(desk, d, all, waiting, now);
    } catch (error) {
      // One card that fails never holds the others, nor itself: it goes through.
      log("desk.gate", { ...errorOf(error), card: d.id, ok: false });
      recordDelivered(d.id, { rules: ["gate failed"], verdict: "deliver" });
    }
  }
}

/** The gate on one pending card `d`: its verdict, one `delivered` line, and a send-back's wake. */
async function gateCard(
  desk: Desk,
  d: Decision,
  all: readonly Decision[],
  waiting: number,
  now: Date
) {
  if (isFollowUpOf(desk.db, d)) {
    recordDelivered(d.id, { rules: ["follow-up"], verdict: "deliver" }, now);
    return;
  }
  const instructions = cardInstructionsOf({
    draft: d.draft,
    matter: d.matter,
  });
  const readings = await readGate(gateCardOf(d), instructions, waiting);
  const assignment = assignmentOfCard(desk.db, d);
  const wasSentBack = all.some(
    (o) =>
      o.id !== d.id &&
      o.subject === d.subject &&
      assignmentOfCard(desk.db, o) === assignment &&
      deliveryOf(o, now).state === "sent_back"
  );
  const replyAt = replyAtOf(d.draft, now);
  const v = gateVerdictOf({
    deadline: d.deadline,
    isAppOpen: Boolean(appOpenSinceOf(now)),
    now: clock(),
    ...(replyAt === undefined ? {} : { replyAt }),
    readings,
    wasSentBack,
    ...effectsOf(instructions, now),
  });
  const { verdict: _, ...line } = v;
  recordDelivered(
    d.id,
    { ...line, ...(readings ? { readings } : {}), verdict: v.verdict },
    clock()
  );
  log("desk.gate", { card: d.id, rules: v.rules, verdict: v.verdict });
  if (v.verdict === "send_back" && assignment) {
    queue(desk.db, SENT_BACK, [
      { assignment, eventId: `${d.id}.${SENT_BACK}`, payload: { id: d.id } },
    ]);
  }
}
