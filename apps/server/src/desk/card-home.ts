import {
  type AssignmentRow,
  anchorsOf,
  openAssignments,
  standingAgents,
} from "../host/desk-read";
import { matterFinderOf } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { agentForMatterOf } from "../memory/read-matters";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import type { Desk } from "./desk-store";

/**
 * Where agent `s.agent_id`'s card on `given` goes (his rule of 21 Nov 2026: on any matter it holds): its open assignment
 * whose anchors find that matter (`s` first), else, on one it takes (`agentForMatterOf`), its own; none given, `s`. An own
 * assignment's other subjects stay the agent's to give (the caretaker's are no matter); any other is refused.
 */
export async function cardHomeOf(
  db: Desk["db"],
  s: AssignmentRow,
  given?: string
) {
  if (given === undefined) {
    return { home: s, subject: anchorsOf(db, s.id)[0] };
  }
  const people = await readPeople();
  const find = matterFinderOf(await readMatterBook(people, dayNow()));
  const v = find([given]);
  const mine = [s, ...openAssignments(db).filter((a) => a.id !== s.id)]
    .filter((a) => a.agent_id === s.agent_id)
    .map((a) => ({ a, w: find(anchorsOf(db, a.id)) }));
  const own = mine.find((m) => anchorsOf(db, m.a.id).length === 0)?.a;
  const home =
    mine.find(
      ({ w }) => w?.id === given || w?.steps.some((x) => x.ref === given)
    )?.a ??
    (v && agentForMatterOf(standingAgents(db), people.truth)(v) === s.agent_id
      ? own
      : undefined) ??
    (own === s ? s : undefined);
  if (!home) {
    throw new Error(
      `Not done: ${given} is not on a matter you hold: a card's subject is a matter of one of your assignments, or one your agent takes.`
    );
  }
  return { home, subject: given };
}
