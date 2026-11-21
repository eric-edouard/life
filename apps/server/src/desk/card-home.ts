import {
  type AssignmentRow,
  anchorsOf,
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
  // A matter he moved to another agent is that agent's alone (decision 78), whoever's project it is.
  const pinned = pinnedAssignmentsOf(db);
  const isMovedAway =
    v &&
    openAssignments(db).some(
      (a) =>
        a.agent_id !== s.agent_id &&
        pinned.has(a.id) &&
        find(anchorsOf(db, a.id), pick(a))?.id === v.id
    );
  const home =
    held?.a ??
    (v &&
    !isMovedAway &&
    agentForMatterOf(standingAgents(db), people.truth)(v) === s.agent_id
      ? own
      : undefined) ??
    (!v && own === s ? s : undefined);
  if (!home) {
    throw new Error(
      `Not done: ${given} is not on a matter you hold: a card's subject is a matter of one of your assignments, or one your agent takes.`
    );
  }
  return { home, matter: v?.id, subject: given };
}
