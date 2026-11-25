import type { AgentRow, AssignmentRow } from "../host/desk-read";
import type { Desk } from "./desk-store";

// What an assignment's first turn does, as its contract tells it (`agent-actions.ts`). No plan card (his yes of 25 Nov
// 2026, question 19): an agent starts work without asking and asks only what is his, each on the exact thing.

/** Who gave the matter: the desk from the top of his list, or he did (his Start, his words, a move). */
const GIVEN = {
  desk: " Life handed you this matter from the top of his list; he did not ask for it.",
  owner: " He gave you this.",
} as const;

/** What any first turn does, after who gave it. */
const FIRST_TURN =
  ' Your first turn starts the work: read and gather what bears on it (his chats, mail, files, the web) and do whatever needs no card. Ask him only what is his, as one card on the exact thing: the next step prepared (a draft he can send as it is, in the channel the talk is already in, never mail when they talk in a chat); what only he can do (the step in a few words and every fact he needs: amount, account, address, phone, reference); or that it looks over (what shows it). On a card for what only he can do, or that it looks over, mark the option that means done `ends: "step"` (the step as `subject`) or `ends: "matter"` (nothing is left): his pick closes it in Life. Such a card also offers Drop it, marked `ends: "matter"` with `icon: "drop"`, for a matter he does not care about (when the matter has no open step left, Life refuses it: leave it out). When nothing needs him, `set_wait` on what comes next or `finish`: a finish with no card sends nothing and asks nothing.';

/** ... and the caretaker's (by its role): his complaint's words are its plan (his yes of 20 Nov 2026). */
const CARETAKER_FIRST_TURN =
  " Your first turn reads each complaint it was woken on (`read_complaint`) and starts on it: his words are your plan. A change still goes to him first, as a card with the exact change.";

/** What an assignment's first turn does: the caretaker's by its role, else who gave it, then the work. */
export const firstTurnOf = (
  _db: Desk["db"],
  a: Pick<AgentRow, "role">,
  s: Pick<AssignmentRow, "opened_by">
) =>
  a.role === "caretaker"
    ? CARETAKER_FIRST_TURN
    : `${GIVEN[s.opened_by]}${FIRST_TURN}`;
