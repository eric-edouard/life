import type { AgentRow, AssignmentRow } from "../host/desk-read";
import { MOVE_NOTES } from "../host/move-read";
import { hasUnreadQuestion } from "./agent-questions";
import type { Desk } from "./desk-store";
import { MAIN_ASK } from "./main-session";

// What an agent's turn may call at the door (`desk-door.ts` asks it before each tool): one rule, beside the acts
// themselves (`agent-actions.ts`).

/**
 * Why the door refuses tool `name` on a desk turn of cause `cause` (none outside one) of `a` on `s`: a move's notes turn only writes its notes
 * (`agent-moves.ts`); the main session's acts are its own; and a turn waits or finishes only once it read his question
 * to it (`hasUnreadQuestion`). Null: it may go.
 */
export function turnRefusalOf(
  desk: Desk,
  name: string,
  cause: string | undefined,
  a: AgentRow | null,
  s: AssignmentRow
) {
  if (
    cause === MOVE_NOTES &&
    name !== "write_notes" &&
    name !== "read_packet"
  ) {
    return "Not done: this turn only writes your notes before the move (`write_notes`), then stops.";
  }
  // The main session (Ask Life): on a turn of his words, `answer`, a card (`request_decision`) and its acts, each of
  // his words (`said`); nothing else of the door, and no other agent has its acts.
  if (cause === MAIN_ASK || a?.role === "main") {
    return cause === MAIN_ASK &&
      (MAIN_TOOLS.has(name) || name === "request_decision")
      ? null
      : `Not done: the main session acts only on a turn of his words, through \`answer\`, \`request_decision\` and its acts (${[...MAIN_TOOLS].join(", ")}).`;
  }
  // The caretaker fixes Life's memory itself, on the words of the complaint it holds (his ruling of 22 Nov 2026).
  if (MAIN_TOOLS.has(name) && !isCaretakerFix(name, a)) {
    return `Not done: \`${name}\` is the main session's alone.`;
  }
  const isEnd = name === "set_wait" || name === "finish";
  return isEnd && hasUnreadQuestion(desk.db, s)
    ? "Not done: he asked you a question through Ask Life: read it (`read_question`) and answer it (`answer_question`) first."
    : null;
}

/** Whether `name` is the caretaker's one act beside the ordinary door: `correct_memory`, on his complaint's words. */
export const isCaretakerFix = (name: string, a: AgentRow | null) =>
  name === "correct_memory" && a?.role === "caretaker";

/** The door's tools only the main session has, on a turn of his words: `answer` and its acts. */
const MAIN_TOOLS = new Set([
  "answer",
  "change_appointment",
  "change_directory_entry",
  "change_registered_agent",
  "change_todo_item",
  "complain",
  "correct_memory",
  "delete_from_memory",
  "show",
  "tell_agent",
  "tell_life",
]);
