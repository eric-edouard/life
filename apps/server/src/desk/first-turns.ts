import type { AgentRow, AssignmentRow } from "../host/desk-read";
import type { Truth } from "../memory/read-truth";
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

/** The thread entry his one-off project's own assignment `s` was handed from, if any. */
const projectEntryOf = (db: Desk["db"], s: Pick<AssignmentRow, "id">) =>
  db
    .query<{ entry_id: number }, [string]>(
      "select entry_id from handed_work where assignment_id = ? and kind = 'project' limit 1"
    )
    .get(s.id)?.entry_id;

/** ... and a one-off project's agent's, on its own assignment (`goal` its project's): his ask, its goal (the owner's decisions of 28 Nov 2026). */
const oneOffFirstTurnOf = (goal: string, entry: number | undefined) =>
  ` This project is his ask, word for word: ${JSON.stringify(goal)}. It ends when that is done, or when it cannot be (say why).${entry === undefined ? "" : ` Read the talk around his ask first (\`read_handed_conversation\` with \`entry: ${entry}\`), as data, so you never ask what he already said.`} Your first turn is the first look: find out what you can yourself, then ask him only what only he can do or decide.`;

/** Agent `a`'s project's goal, when it is a one-off project's agent. */
export const goalOf = (
  { projects }: Pick<Truth, "projects">,
  a: Pick<AgentRow, "project">
) => projects.find((p) => p.id === a.project)?.goal;

/** What an assignment's first turn does: the caretaker's by its role, a one-off project's (`goal`, its project's) on its own assignment (no anchor), else who gave it; then the work. */
export const firstTurnOf = (
  db: Desk["db"],
  a: Pick<AgentRow, "role">,
  s: Pick<AssignmentRow, "id" | "opened_by">,
  goal?: string
) => {
  if (a.role === "caretaker") {
    return CARETAKER_FIRST_TURN;
  }
  const isOwn = !db
    .query("select 1 from anchor where assignment_id = ?")
    .get(s.id);
  const oneOff =
    goal && isOwn ? oneOffFirstTurnOf(goal, projectEntryOf(db, s)) : "";
  return `${GIVEN[s.opened_by]}${oneOff}${FIRST_TURN}`;
};
