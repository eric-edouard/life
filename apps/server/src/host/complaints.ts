import { z } from "zod";
import { clock } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { off } from "../core/outputs";
import { COMPLAINT_RETRIED } from "../core/paths";
import { isSealed } from "../memory/complaint-checks";
import { stageOf } from "../memory/complaint-record";
import { askOf } from "../memory/memory-files";
import { type Complaint, complaintOf } from "../records/ledger-entry";
import { ask } from "./asks";
import { WAIT_MS } from "./change-registered-agent";
import { entryId } from "./change-todo-item";
import { complaintReceiptOf, readDesk } from "./desk-read";
import type { ToolCall } from "./http/mcp-tool";
import { openChecksNow } from "./inbox";

// His complaint: his "Wrong…" on a card of Life's (`answer_check` with `value.kind` `misread`), with his words. One
// press is one ask of the desk in the ledger, its id made from the press's key (`life/answerKey`), so a retry never asks
// twice; then this waits for the desk to receive it for the caretaker, which writes its complaint record row first and
// its receipt (its event row, `complaintReceiptOf`) after. Only then does his app hear `reached: "caretaker"`: the ask,
// the row and the receipt are all written. Any failure keeps his words with his app, and a retry under the key resumes.

/**
 * What his app sends with his words: the card's `misread` as it read it (`cause`, `shown`, `seal`) and his tick on the
 * anonymized report; `repeated` on its own repeat of a call whose connection dropped, never on his press.
 */
export const Misread = z
  .object({
    cause: z.string().min(1).max(64),
    kind: z.literal("misread"),
    repeated: z.boolean().optional(),
    report: z.boolean(),
    seal: z.string().min(1).max(64),
    shown: z.string().min(1).max(64),
  })
  .strict();
export type Misread = z.infer<typeof Misread>;

const POLL_MS = 500;
/** The plan is said again this often while the desk has not received it (its steps only: a limit said again would move the phone's deadline); the phone gives up after 15 s with no byte. */
const STILL_WAITING_MS = 5000;

/**
 * The complaint his press makes on card `ref` (sealed, `complain` checks): with the card as read now, whether it is the
 * one he saw, and the prompt of the stage that made it, frozen at his press (`stageOf`).
 */
async function complaintNow(ref: string, m: Misread): Promise<Complaint> {
  const card = (await openChecksNow()).find((c) => c.ref === ref) ?? null;
  return {
    card,
    cause: m.cause,
    isAsShown: card?.misread?.shown === m.shown,
    ...stageOf(card),
    ref,
    report: m.report,
    shown: m.shown,
  };
}

/** Waits for the desk's receipt of complaint `id`: `reached` once received, else a refusal that names why. */
async function reached(
  id: string,
  limitMs: number,
  report: ToolCall["report"]
) {
  const plan = { limitSeconds: limitMs / 1000, plan: ["recorded", "received"] };
  report(plan);
  report({ at: clock().toISOString(), step: "recorded" });
  for (let waited = 0; ; waited += POLL_MS) {
    const r = readDesk((db) => complaintReceiptOf(db, id), null);
    if (r.state === "ok" && r.value) {
      report({ at: clock().toISOString(), step: "received" });
      return { ask: id, reached: "caretaker" };
    }
    if (waited >= limitMs) {
      const why = {
        off: "the desk is off",
        ok: `the desk has not received it in ${limitMs / 1000} s`,
        unreadable: r.state === "unreadable" ? r.why : "",
      }[r.state];
      throw new Error(
        `Not done: ${why}. His words are recorded: try again with the same key.`
      );
    }
    // The same steps again change nothing on the phone and keep its stream alive through a slow tick.
    if (waited > 0 && waited % STILL_WAITING_MS === 0) {
      report({ plan: plan.plan });
    }
    // biome-ignore lint/performance/noAwaitInLoops: polls the desk's receipt
    await Bun.sleep(POLL_MS);
  }
}

/**
 * Records his complaint on card `ref` (his words `note`), once per press key, and returns `{ ask, reached: "caretaker" }`
 * once the desk received it. A retry of the press (its key, the same words, card, cause and tick) resumes it, even after
 * the card left; the same key with anything else is refused.
 */
export async function complain(
  ref: string,
  note: string | undefined,
  m: Misread,
  { answerKey, report }: ToolCall,
  limitMs = WAIT_MS
) {
  const why = off("desk");
  if (why) {
    throw new Error(`Not done: ${why}`);
  }
  if (!answerKey) {
    throw new Error(
      "Not done: a complaint needs its press's key (`life/answerKey`), so a retry never asks twice."
    );
  }
  if (!note?.trim()) {
    throw new Error("Not done: a complaint needs his words (`note`).");
  }
  // Checked on every press, a retry under a recorded key too: only a "Wrong…" Life showed.
  if (!isSealed(ref, m)) {
    throw new Error(
      "Not done: “Wrong…” takes a card of Life's as Life showed it (its `misread`); an agent's card takes his answer or his words."
    );
  }
  const instruction = {
    at: clock().toISOString(),
    quote: note,
    ref: `complaint:${answerKey}`,
  };
  const recorded = askOf(entryId(instruction.ref, "ask", ""));
  const asked =
    recorded ??
    ask(
      instruction,
      { agent: DESK_AGENT, complaint: await complaintNow(ref, m) },
      "connector",
      "his word that a card of Life's is wrong"
    );
  const c = complaintOf(asked);
  if (
    !c ||
    asked.instruction?.quote !== note ||
    c.ref !== ref ||
    c.cause !== m.cause ||
    c.shown !== m.shown ||
    c.report !== m.report
  ) {
    throw new Error(
      "Not done: this key recorded another press; a new press takes a new key."
    );
  }
  // His own Try again on a complaint the desk has not received is a press too: a caretaker that never started tries
  // once more for it (`roleStartBlockOf`). A replay of one received, or his app's repeat of a dropped call, is none.
  const receipt =
    recorded && !m.repeated
      ? readDesk((db) => complaintReceiptOf(db, recorded.id), null)
      : null;
  if (receipt?.state === "ok" && !receipt.value) {
    await Bun.write(COMPLAINT_RETRIED, clock().toISOString());
  }
  return await reached(asked.id, limitMs, report);
}

/**
 * His complaint through Tell Life (the main session's `complain`, his words `said` found in his ask): on card `ref` when
 * one was on his screen (read now: null when it left; its cause Life's own, so it shows as being fixed), else on nothing
 * but his words; one per ask `key` (a second call
 * under it is the first). `report`: he asked for the anonymized report to the developer. `{ ask, reached }` once the
 * desk received it for the caretaker, as a press's.
 */
export async function complainThroughTellLife(
  said: string,
  ref: string | undefined,
  report: boolean,
  key: string,
  limitMs = WAIT_MS
) {
  const why = off("desk");
  if (why) {
    throw new Error(`Not done: ${why}`);
  }
  const card = ref
    ? ((await openChecksNow()).find((c) => c.ref === ref) ?? null)
    : null;
  const asked = ask(
    { at: clock().toISOString(), quote: said, ref: `complaint:${key}` },
    {
      agent: DESK_AGENT,
      complaint: {
        card,
        // The card's own cause as Life reads it now, so it shows as being fixed; none on his words alone.
        ...(card?.misread ? { cause: card.misread.cause } : {}),
        ...stageOf(card),
        ref: ref ?? "",
        report,
      } satisfies Complaint,
    },
    "connector",
    "his word through Tell Life that Life got something wrong"
  );
  return await reached(asked.id, limitMs, () => undefined);
}
