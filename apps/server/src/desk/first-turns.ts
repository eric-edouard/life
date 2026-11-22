import type { AgentRow, AssignmentRow } from "../host/desk-read";
import { isHisWordsPlanOf, opensWithPlan } from "../host/inbox";
import { askPageOf } from "../memory/card-request";
import type { Desk } from "./desk-store";

// What an assignment's first turn does, as its contract tells it (`agent-actions.ts`), and whether the door lets it
// wait or finish before a card (`desk-door.ts`): a plan card first, unless his own words are its plan (`isHisWordsPlanOf`).

/** The one sentence of the contract that differs: what a first turn does when he asked for the agent (his plan card, then his `start`). */
const PLAN_FIRST_TURN = ` Your first turn only reads and asks your plan card. ${askPageOf("ask/plan")} Act only after his \`start\`; on his \`decline\`, \`finish\`; on his own words instead, read them and ask a follow-up card: a changed plan is a new plan card, its steps in \`plan\`.`;

/** ... and when the desk started it itself (`hand-out.ts`): no plan card, one card of what it found. */
const HANDED_OUT_FIRST_TURN =
  ' Life handed you this matter from the top of his list; he did not ask for it. Your first turn reads and gathers (his chats, mail, files, the web), then asks ONE card, whichever is true: the next step prepared (a draft he can send as it is, in the channel the talk is already in, never mail when they talk in a chat); what only he can do (the step in a few words and every fact he needs for it: amount, account, address, phone, reference); or that it looks over (what shows it). On a card for what only he can do, or that it looks over, mark the option that means done `ends: "step"` (the step as `subject`) or `ends: "matter"` (nothing is left): his pick closes it in Life. Every card also offers Drop it, marked `ends: "matter"` with `icon: "drop"`, for a matter he does not care about: his pick of it alone closes the matter in Life (when the matter has no open step left, Life refuses it: leave it out and say in the context that he can tell you to stop). No other option closes anything. Then wait for his answer; finish when the step is done or nothing is left for you.';

/** How a first turn's card reads (his words of 21 and 22 Nov 2026: a plan card reads well, as steps his app draws, never a wall of text): what it found in `context`, a plan's steps in `plan` only. */
const PLAN_AS_STEPS =
  " That card's `context` is what you found, as a few short bullets; its question stays one line. Any plan on any card goes in `plan`, its steps, never as a numbered list in `context`.";

/** ... and the caretaker's (by its role): his complaint's words are its plan (his yes of 20 Nov 2026). */
const CARETAKER_FIRST_TURN =
  " Your first turn reads each complaint it was woken on (`read_complaint`) and starts on it: his words are your plan, so ask no plan card and wait for no `start`. A change still goes to him first, as a card with the exact change.";

/** ... and the Personal agent's on his spoken ask: his words are its plan (his decision of 21 Nov 2026). */
const SPOKEN_ASK_FIRST_TURN =
  " Your first turn reads each spoken ask it was woken on (`ask.spoken`: `read_spoken_ask`) and starts on it: his words are your plan, so ask no plan card and wait for no `start`. Anything outward still goes to him first, as a card on the exact content.";

/** What an assignment's first turn does: the caretaker's by its role, the Personal agent's on his spoken ask (`isHisWordsPlanOf`); else his plan card first when it opens with a plan (`opensWithPlan`: he opened it, or it moved in, the door's rule too), one card of what it found when the desk did, either card's plan as `plan` steps. */
export function firstTurnOf(
  db: Desk["db"],
  a: Pick<AgentRow, "role">,
  s: Pick<AssignmentRow, "agent_id" | "id" | "opened_by">
) {
  if (a.role === "caretaker") {
    return CARETAKER_FIRST_TURN;
  }
  if (isHisWordsPlanOf(db, a, s)) {
    return SPOKEN_ASK_FIRST_TURN;
  }
  return `${opensWithPlan(db, s) ? PLAN_FIRST_TURN : HANDED_OUT_FIRST_TURN}${PLAN_AS_STEPS}`;
}
