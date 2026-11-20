import type { AgentKind } from "../records/registered-agent";

// Which matters registered agents hold (docs/tasks.md, "held"): the one rule, pure, for the hand-out (`handOutOf`) and the
// new matter check alike. The facts come from the desk's store (host's `heldByAgents`), which memory cannot read.

/** How the desk ends an agent whose matter looks over (no longer running) on a model's reading: it holds nothing after. */
export const MATTER_OVER_OUTCOME = "its matter looks over";

/** One registered agent's subject, as a fact: its anchored step or its project (one of the two), when it ended (null while active or stopped), who started it, how it ended, why it never began. */
export interface AgentHold {
  /** The agent's id (`agt_…`). */
  agent: string;
  endedAt: string | null;
  kind: AgentKind;
  outcome: string | null;
  project: string | null;
  status: string;
  step: string | null;
  whyNotStarted: string | null;
}

/** Whether `h` holds a matter whose newest step is at `newest`: active or stopped; ended, until the matter has a step newer than its end, unless it was ended because its matter looked over, or he asked for it and it never began. */
const isHolding = (h: AgentHold, newest: string) =>
  h.endedAt === null ||
  (h.outcome !== MATTER_OVER_OUTCOME &&
    (h.whyNotStarted === null || h.kind === "handed_out") &&
    newest <= h.endedAt);

/**
 * The test of "an agent holds this matter", over `holds`: the first hold that holds it, or undefined. One of its steps
 * is anchored by an agent that holds it (`isHolding`), or, with `isByProject`, one of its projects is that agent's
 * subject (the new matter check while the hand-out is off: his project's agent answers for its matters). Pure.
 */
export function isHeldOf(holds: readonly AgentHold[], isByProject = false) {
  const byStep = Map.groupBy(holds, (h) => h.step ?? "");
  const byProject = Map.groupBy(holds, (h) => h.project ?? "");
  return (v: {
    projects?: readonly string[];
    steps: readonly { at: string; ref: string }[];
  }): AgentHold | undefined => {
    const newest = v.steps.at(-1)?.at ?? "";
    const holders = [
      ...v.steps.map((s) => byStep.get(s.ref)),
      ...(isByProject ? (v.projects ?? []).map((p) => byProject.get(p)) : []),
    ];
    return holders
      .flatMap((list) => list ?? [])
      .find((h) => isHolding(h, newest));
  };
}
