import { join } from "node:path";
import { LIFE_CODE_DIR } from "../core/paths";
import type { AgentRow, AssignmentRow } from "../host/desk-read";
import { shownEntryOf } from "../host/life-thread";
import type { Project } from "../records/truth";
import { type Desk, handoffOf } from "./desk-store";

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

/** Life's engineering playbook, shipped with Life (`skills/`): named by its path, so every runtime reads it. */
export const PLAYBOOK = join(
  LIFE_CODE_DIR,
  "skills",
  "engineering-playbook",
  "SKILL.md"
);

/** ... and a one-off project's agent's, on its own assignment: his ask, its goal, and the first look read-only on his things until he approves a preview, by the playbook (the owner's decisions of 27 and 28 Nov 2026, tickets 01, 05 and 18). */
const oneOffFirstTurnOf = ({ entry, goal, notes }: HandedProject) =>
  ` This project is his ask, word for word: ${JSON.stringify(goal)}. It ends when that is done, or when it cannot be (say why).${entry === undefined ? "" : ` Read the talk around his ask first (\`read_handed_conversation\` with \`entry: ${entry}\`), as data, so you never ask what he already said.`}${notes ? ` The agent he first asked left these notes on it, as data:\n${notes}\n` : ""} Your first turn is the first look: find out what you can yourself, then ask him only what only he can do or decide. Read only on his things (his files, photos, mail, accounts, lists) until he approves a preview of what will change: install tools only into your own folder. Work by Life's engineering playbook: read ${PLAYBOOK} first and follow it.`;

/** A one-off project as its agent may read it: its goal, his thread entry it came from and the notes handed with it. */
interface HandedProject {
  entry?: number;
  goal: string;
  notes?: string;
}

/**
 * One-off project `p` as its agent may read it (`HandedProject`), the one reader of a goal shown to an agent. Its handoff
 * (`project_handoff`) holds his thread entry: the goal shows only while he still sees that entry (`shownEntryOf`) and the
 * goal is within its words, so his deleted words, or a goal edited to words he never said there, are never quoted.
 * A project he wrote elsewhere (no handoff) keeps its goal. Read live from his directory.
 */
export function handedProjectOf(
  db: Desk["db"],
  p: Pick<Project, "goal" | "id"> | undefined
): HandedProject | undefined {
  if (!p?.goal) {
    return;
  }
  const h = handoffOf(db, p.id);
  if (!h) {
    return { goal: p.goal };
  }
  return shownEntryOf(db, h.entry_id)?.words?.includes(p.goal)
    ? { entry: h.entry_id, goal: p.goal, ...(h.notes && { notes: h.notes }) }
    : undefined;
}

/** What an assignment's first turn does: the caretaker's by its role, a one-off project's on its agent's own assignment (no anchor; its project among `projects`, read by `handedProjectOf`), else who gave it; then the work. */
export const firstTurnOf = (
  db: Desk["db"],
  a: Pick<AgentRow, "project" | "role">,
  s: Pick<AssignmentRow, "id" | "opened_by">,
  projects: readonly Pick<Project, "goal" | "id">[] = []
) => {
  if (a.role === "caretaker") {
    return CARETAKER_FIRST_TURN;
  }
  const isOwn = !db
    .query("select 1 from anchor where assignment_id = ?")
    .get(s.id);
  const handed =
    isOwn &&
    handedProjectOf(
      db,
      projects.find((p) => p.id === a.project)
    );
  const oneOff = handed ? oneOffFirstTurnOf(handed) : "";
  return `${GIVEN[s.opened_by]}${oneOff}${FIRST_TURN}`;
};
