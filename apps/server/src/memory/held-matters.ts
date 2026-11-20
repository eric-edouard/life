import type { AgentKind } from "../records/registered-agent";

// Which matters registered agents hold (docs/tasks.md, "held"): the one rule, pure, for the hand-out (`handOutOf`) and the
// new matter check alike. The facts come from the desk's store (host's `heldByAgents`), which memory cannot read.

/** How the desk ends an agent whose matter looks over (no longer running) on a model's reading: it holds nothing after. */
export const MATTER_OVER_OUTCOME = "its matter looks over";

/** One registered agent's anchor, as a fact: its step, when it ended (null while active or stopped), who started it, how it ended, why it never began. */
export interface AgentHold {
  endedAt: string | null;
  kind: AgentKind;
  outcome: string | null;
  step: string;
  whyNotStarted: string | null;
}

/** Whether `h` holds a matter whose newest step is at `newest`: active or stopped; ended, until the matter has a step newer than its end, unless it was ended because its matter looked over, or he asked for it and it never began. */
const isHolding = (h: AgentHold, newest: string) =>
  h.endedAt === null ||
  (h.outcome !== MATTER_OVER_OUTCOME &&
    (h.whyNotStarted === null || h.kind === "handed_out") &&
    newest <= h.endedAt);

/** The test of "an agent holds this matter", over `holds`: one of its steps is anchored by an agent that holds it (`isHolding`). Pure. */
export function isHeldOf(holds: readonly AgentHold[]) {
  const byStep = Map.groupBy(holds, (h) => h.step);
  return (v: { steps: readonly { at: string; ref: string }[] }) => {
    const newest = v.steps.at(-1)?.at ?? "";
    return v.steps.some((s) =>
      (byStep.get(s.ref) ?? []).some((h) => isHolding(h, newest))
    );
  };
}
