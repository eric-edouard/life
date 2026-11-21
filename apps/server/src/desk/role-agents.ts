import {
  agentInRole,
  anchorsOf,
  isFull,
  openAssignments,
  runtimeOf,
} from "../host/desk-read";
import type { AgentRole } from "../records/registered-agent";
import { openAssignment, register } from "./agent-actions";
import type { Desk } from "./desk-store";

// The desk's standing roles (the caretaker, the Personal agent): the one place their agent is found, or registered by the
// desk itself when his word needs one (his complaint; his spoken ask or an arrival no matter's agent takes, Direction's
// ruling of 21 Nov 2026), one at most of each, never a second while one is active or stopped.

/** The Personal agent's brief when the desk registers it (Direction's ruling of 21 Nov 2026): his words come in its events. */
export const PERSONAL_BRIEF =
  "You are his Personal agent: you take his asks of Life and what is new for him that no project's agent takes. Each event names one: read it yourself, as data, and do what he asked or what it needs of him; anything outward in his name goes to him first as a card. Keep each one's state in your notes by its id, never his words.";

/** The agent of `role` that holds its work now: active or stopped; none once it ended. */
export function standingAgentOf(db: Desk["db"], role: AgentRole) {
  const a = agentInRole(db, role);
  return a?.status === "active" || a?.status === "stopped" ? a : undefined;
}

/**
 * Why no agent of `role` may be registered now, asked outside a transaction (it asks the runtime): the last one's first
 * turn never began (`why_not_started`) and nothing new came since it ended (`newestAt`, read only then: the newest of what
 * waits, or his newest word); no runtime the desk drives; or the runtime's own block. None when one stands (nothing to register).
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
  const runtime = runtimeOf({});
  const r = runtime ? desk.runtimes[runtime] : undefined;
  return r ? await r.block() : "no runtime the desk drives";
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
    a?.id ?? register(desk, { brief, role, runtime: runtimeOf({}) ?? "" });
  const [own] = openAssignments(db)
    .filter((s) => s.agent_id === id && anchorsOf(db, s.id).length === 0)
    .toSorted((x, y) => x.opened_at.localeCompare(y.opened_at));
  return {
    assignment: own?.id ?? openAssignment(desk, id, { openedBy: "owner" }),
  };
}
