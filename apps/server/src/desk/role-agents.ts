import type { AgentRole } from "../core/names";
import { agentInRole, isFull, runtimeOf } from "../host/desk-read";
import { insertAgent, openAssignment, register } from "./agent-actions";
import type { Desk } from "./desk-store";
import { startBlockOf } from "./runtime-fallback";

// The desk's standing roles (the main session, the caretaker, the Personal agent): the one place their agent is found, or
// registered by the desk itself: the main session and the caretaker from the desk's start (`standUp`, his word of 22 Nov
// 2026: "we should create a main agent, and then we should also create the caretaker"), the Personal agent when his word
// needs one (his spoken ask or an arrival no matter's agent takes, Direction's ruling of 21 Nov 2026); one at most of
// each, never a second while one is active or stopped.

/** The Personal agent's brief when the desk registers it (Direction's ruling of 21 Nov 2026): his words come in its events. */
export const PERSONAL_BRIEF =
  "You are his Personal agent: you take his asks of Life and what is new for him that no project's agent takes. Each event names one: read it yourself, as data, and do what he asked or what it needs of him; anything outward in his name goes to him first as a card. Keep each one's state in your notes by its id, never his words.";

/** The agent of `role` that holds its work now: active or stopped; none once it ended. */
export function standingAgentOf(db: Desk["db"], role: AgentRole) {
  const a = agentInRole(db, role);
  return a?.status === "active" || a?.status === "stopped" ? a : undefined;
}

/**
 * Registers `role`'s agent on `brief` when none stands, each tick (his word of 22 Nov 2026): with no assignment, so it runs
 * no turn until his words or a complaint come (`roleAssignmentOf` opens one then). None while its last agent's first turn
 * never began (what comes next for it tries again: `roleStartBlockOf`), or on a full desk.
 */
export function standUp(desk: Desk, role: AgentRole, brief: string) {
  const { db } = desk;
  db.transaction(() => {
    if (
      !(
        standingAgentOf(db, role) ||
        agentInRole(db, role)?.why_not_started ||
        isFull(db)
      )
    ) {
      insertAgent(db, { brief, role, runtime: runtimeOf({ role }) });
    }
  })();
}

/**
 * Why no agent of `role` may be registered now, asked outside a transaction (it asks the runtime): the last one's first
 * turn never began (`why_not_started`) and nothing new came since it ended (`newestAt`, read only then: the newest of what
 * waits, or his newest word); or neither its runtime nor pi runs (`startBlockOf`). None when one stands (nothing to register).
 */
export async function roleStartBlockOf(
  desk: Desk,
  role: AgentRole,
  newestAt: () => string
) {
  if (standingAgentOf(desk.db, role)) {
    return;
  }
  const last = agentInRole(desk.db, role);
  if (
    last?.status === "ended" &&
    last.why_not_started &&
    newestAt() <= (last.ended_at ?? "")
  ) {
    return `the ${role} agent did not start (${last.why_not_started}); what comes next tries again`;
  }
  return await startBlockOf(desk, runtimeOf({ role }));
}

/**
 * Where work for `role` goes now (in the caller's transaction): its agent's own open assignment (no anchors), one opened
 * for an active agent that holds none, or a new agent registered on `brief` (`blocked`, from `roleStartBlockOf`, or a
 * full desk, stops that); a stopped agent holds it back until he resumes or replaces it.
 */
export function roleAssignmentOf(
  desk: Desk,
  role: AgentRole,
  brief: string,
  blocked: string | undefined
): { assignment: string } | { why: string } {
  const { db } = desk;
  const a = standingAgentOf(db, role);
  if (a?.status === "stopped") {
    return { why: `the ${role} agent ${a.id} is stopped` };
  }
  if (!a && (blocked || isFull(db))) {
    return { why: blocked ?? "the desk keeps 50 agents active at most" };
  }
  const id =
    a?.id ?? register(desk, { brief, role, runtime: runtimeOf({ role }) });
  return {
    assignment:
      ownAssignmentOf(db, id) ??
      openAssignment(desk, id, { openedBy: "owner" }),
  };
}

/** Agent `agent`'s own open assignment (no anchors), the first opened: where its role's work goes. */
export const ownAssignmentOf = (db: Desk["db"], agent: string) =>
  db
    .query<{ id: string }, [string]>(
      "select id from assignment where agent_id = ? and closed_at is null and id not in (select assignment_id from anchor) order by opened_at limit 1"
    )
    .get(agent)?.id;
