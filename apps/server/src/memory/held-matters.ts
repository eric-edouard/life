import type {
  AgentRole,
  AgentStatus,
  OpenedBy,
} from "../records/registered-agent";

// Which matters registered agents hold, and which agent takes a matter (docs/tasks.md, "held"): the rules, pure, for
// the hand-out (`handOutOf`), the fold and the new matter check alike. The facts come from the desk's store (host's
// `heldByAgents`, `standingAgents`), which memory cannot read.

/** How the desk ends an agent whose matter looks over (no longer running) on a model's reading: it holds nothing after. */
export const MATTER_OVER_OUTCOME = "its matter looks over";

/** One anchored step of a registered agent's assignment, as a fact: when the assignment closed (null while open), who opened it, how it closed, why it never began. */
export interface AgentHold {
  /** The agent's id (`agt_…`). */
  agent: string;
  closedAt: string | null;
  openedBy: OpenedBy;
  outcome: string | null;
  status: AgentStatus;
  step: string;
  whyNotStarted: string | null;
}

/** Whether `h` holds a matter whose newest step is at `newest`: open; closed, until the matter has a step newer than its close, unless it was closed because its matter looked over, or he asked for it and it never began. */
const isHolding = (h: AgentHold, newest: string) =>
  h.closedAt === null ||
  (h.outcome !== MATTER_OVER_OUTCOME &&
    (h.whyNotStarted === null || h.openedBy === "desk") &&
    newest <= h.closedAt);

/**
 * The test of "an agent holds this matter", over `holds`: the first hold that holds it, or undefined. One of its steps
 * is anchored by an agent that holds it (`isHolding`); a project's agent holds only what is assigned to it. Pure.
 */
export function isHeldOf(holds: readonly AgentHold[]) {
  const byStep = Map.groupBy(holds, (h) => h.step);
  return (v: {
    steps: readonly { at: string; ref: string }[];
  }): AgentHold | undefined => {
    const newest = v.steps.at(-1)?.at ?? "";
    return v.steps
      .flatMap((s) => byStep.get(s.ref) ?? [])
      .find((h) => isHolding(h, newest));
  };
}

/** An active agent that takes matters: a project's (its own assignment listens to `project`) or the Personal agent. */
export interface StandingAgent {
  id: string;
  name: string | null;
  project: string | null;
  role: AgentRole | null;
}

/**
 * The one test of which agent a matter goes to, by the project it shows under (`projectOf`, his `matter-project` first):
 * the oldest of `standing` (oldest first) on that project, else the Personal agent, else none. A project may have several
 * agents (overlap is fine); the oldest takes its matters. Pure.
 */
export const agentForOf =
  (standing: readonly StandingAgent[]) => (project: string | undefined) =>
    (project ? standing.find((a) => a.project === project) : undefined) ??
    standing.find((a) => a.role === "personal");
