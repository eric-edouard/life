import {
  type AssignmentRow,
  anchorsOf,
  assignmentOf,
  openAssignments,
  standingAgents,
} from "../host/desk-read";
import { pinnedAssignmentsOf } from "../host/move-read";
import { matterFinderOf } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { agentForMatterOf } from "../memory/read-matters";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import type { Desk } from "./desk-store";

/** Whether a matter (`isOnMatter`) was moved by him from `agent` to another agent (decision 78): that agent's alone, whoever's project it is, its holder stopped too. */
function isMovedAwayOf(
  db: Desk["db"],
  agent: string,
  isOnMatter: (a: AssignmentRow) => boolean
) {
  return [...pinnedAssignmentsOf(db)].some((id) => {
    const a = assignmentOf(db, id);
    return a?.closed_at === null && a.agent_id !== agent && isOnMatter(a);
  });
}

/**
 * Where agent `s.agent_id`'s card on `given` goes (his rule of 21 Nov 2026: on any matter it holds): its open assignment
 * whose anchors find the subject's matter (found as the card's writer finds it: `matterFinderOf` over the open matters), else, on one it takes
 * (`agentForMatterOf`), its own; none given, `s`, on its matter's id (its first anchor when no matter holds them). Each
 * assignment's chosen matter (`matter_id`) takes a tie; the matter found rides on the card (`matter`). An own
 * assignment's subjects no matter holds (a project, an area, the caretaker's) stay its agent's to give; any other is
 * refused.
 */
export async function cardHomeOf(
  db: Desk["db"],
  s: AssignmentRow,
  given?: string
) {
  const anchors = anchorsOf(db, s.id);
  if (given === undefined && anchors.length === 0) {
    return { home: s };
  }
  const people = await readPeople();
  const find = matterFinderOf(
    (await readMatterBook(people, dayNow())).filter((m) => m.open)
  );
  const pick = (a: AssignmentRow) => a.matter_id ?? undefined;
  if (given === undefined) {
    const m = find(anchors, pick(s));
    return { home: s, matter: m?.id, subject: m?.id ?? anchors[0] };
  }
  const mine = [s, ...openAssignments(db).filter((a) => a.id !== s.id)]
    .filter((a) => a.agent_id === s.agent_id)
    .map((a) => ({ a, w: find(anchorsOf(db, a.id), pick(a)) }));
  // A subject on a matter one of them holds is that matter (the woken one's first), never a smaller one sharing it.
  const held = mine.find(
    ({ w }) => w && (w.id === given || w.steps.some((x) => x.ref === given))
  );
  const v = held?.w ?? find([given]);
  const own = mine.find((m) => anchorsOf(db, m.a.id).length === 0)?.a;
  // Its agent takes the matter, unless he moved the matter away from it.
  const isTakenBy = (w: NonNullable<typeof v>) =>
    !isMovedAwayOf(
      db,
      s.agent_id,
      (a) => find(anchorsOf(db, a.id), pick(a))?.id === w.id
    ) && agentForMatterOf(standingAgents(db), people.truth)(w) === s.agent_id;
  const home =
    held?.a ??
    (v && isTakenBy(v) ? own : undefined) ??
    (!v && own === s ? s : undefined);
  if (!home) {
    throw new Error(
      `Not done: ${given} is not on a matter you hold: a card's subject is a matter of one of your assignments, or one your agent takes.`
    );
  }
  return { home, matter: v?.id, subject: given };
}
