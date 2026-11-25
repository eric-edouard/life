import {
  type AssignmentRow,
  agentOf,
  anchorsOf,
  assignmentOfCard,
  openAssignments,
  readNotes,
} from "../host/desk-read";
import { decisionsNow } from "../memory/decisions";
import { intentionsNow } from "../memory/instructions";
import { type MatterView, matterOfSteps } from "../memory/matter-read";
import { clip } from "../memory/units";
import type { Desk } from "./desk-store";

// What a packet holds beside its own matter (the v4.1 plan): the standing intention an assignment is anchored on
// (`openIntentions`), and the records of the other work under the same project, read-only, never their sessions.

/** How much of another assignment's last note line a packet shows. */
const OTHER_NOTE_CHARS = 200;

/** The standing intention steps `steps` are, when they are one instruction's id (`openIntentions`): his words, as its subject reads. */
export function intentionLineOf(steps: readonly string[]) {
  const [step] = steps;
  const i =
    steps.length === 1 && step?.startsWith("ins_")
      ? intentionsNow().find((x) => x.id === step)
      : undefined;
  return (
    i &&
    `Your subject: his standing intention (${i.scope}${i.until ? `, until ${i.until}` : ""}): ${JSON.stringify(i.text)}, from his words ${JSON.stringify(i.said)}. Wait on what brings it about (\`set_wait\` on that person's messages, a date) and act on it when it comes; \`finish\` once it is done.`
  );
}

/**
 * The records of the other open assignments under projects `ids` (by their matter's projects in `book`, or their
 * agent's own project), for a packet, read-only: each one's subject, newest plan's steps and last note line.
 * Never their sessions.
 */
export function othersOnProjectsOf(
  db: Desk["db"],
  s: Pick<AssignmentRow, "id">,
  ids: readonly string[],
  book: readonly MatterView[]
) {
  if (ids.length === 0) {
    return [];
  }
  const list = decisionsNow();
  return openAssignments(db).flatMap((o) => {
    const a = o.id === s.id ? null : agentOf(db, o.agent_id);
    if (!a || a.role === "main" || a.role === "caretaker") {
      return [];
    }
    const steps = anchorsOf(db, o.id);
    const v =
      steps.length > 0
        ? matterOfSteps(book, steps, o.matter_id ?? undefined)
        : undefined;
    const projects =
      v?.projects ?? (steps.length === 0 && a.project ? [a.project] : []);
    if (!projects.some((p) => ids.includes(p))) {
      return [];
    }
    const plan =
      list.findLast((d) => d.plan && assignmentOfCard(db, d) === o.id)?.plan ??
      [];
    const last = readNotes(o).trim().split("\n").at(-1) ?? "";
    return [
      `- \`${o.id}\` on ${v ? `${v.name} (${v.id})` : `project ${a.project}`}; its plan: ${plan.map((x) => x.text).join("; ") || "none"}; its last note: ${clip(last, OTHER_NOTE_CHARS) || "none"}`,
    ];
  });
}
