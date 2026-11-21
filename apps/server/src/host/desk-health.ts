import type { AgentHold } from "../memory/held-matters";
import {
  isRunning,
  type MatterView,
  matterFinderOf,
} from "../memory/matter-read";
import {
  type HandOutFacts,
  type HandOutGate,
  handOutGateOf,
} from "../memory/read-matters";

// The desk health check (his yes of 20 Nov 2026), a report in code, no model, no action: where agents and matters
// drift apart (the oddities), how many of the matters to do have an agent and why not the others (`coverageOf`, "agent
// coverage"), and the row of how many running matters need him (`matterRowsNowOf`). Each rule is pure; `readAgentSection` reads and the nightly shows
// every row, never capped.

interface Row {
  name: string;
  relation: string;
}

/** An agent as the oddities read it: its id and status as `read_registered_agents` gives them, and its anchors. */
export interface HealthAgent {
  id: string;
  /** Its matter as the agent list resolved it, with the matter he chose (`readRegisteredAgents`): the finder's pick on a tie. */
  matter?: { id: string } | null;
  project: string | null;
  status: string;
  steps: readonly string[];
}

type Find = (
  refs: readonly string[],
  prefer?: string
) => MatterView | undefined;

/** Whether the desk counts the agent as at work (`running` or `waiting`: `active` in its store). */
const isActive = (a: Pick<HealthAgent, "status">) =>
  a.status === "running" || a.status === "waiting";

const oddity = (agent: string, relation: string): Row => ({
  name: `Desk health · ${agent}`,
  relation,
});

/** Each active agent whose matter is not running (done, dormant or ended): it works on nothing. */
export const activeOnIdleMatterOf = (
  agents: readonly HealthAgent[],
  find: Find
) =>
  agents.flatMap((a) => {
    const v = isActive(a) ? find(a.steps, a.matter?.id) : undefined;
    return v && !isRunning(v)
      ? [oddity(a.id, `active, but its matter "${v.name}" is not running`)]
      : [];
  });

/** Each matter held by two agents or more, active or stopped (`holds`: a project's agent holds none). */
export function heldByTwoOf(
  book: readonly Pick<MatterView, "name" | "steps">[],
  holds: readonly AgentHold[]
) {
  const live = holds.filter((h) => h.closedAt === null && h.step !== null);
  return book.flatMap((v) => {
    const refs = new Set(v.steps.map((s) => s.ref));
    const agents = [
      ...new Set(
        live.filter((h) => refs.has(h.step ?? "")).map((h) => h.agent)
      ),
    ];
    return agents.length > 1
      ? [oddity(v.name, `held by ${agents.join(" and ")}`)]
      : [];
  });
}

/** Each active or stopped agent whose anchors no one matter holds all of: a re-group split them. */
export const splitAnchorsOf = (agents: readonly HealthAgent[], find: Find) =>
  agents.flatMap((a) => {
    if (a.status === "ended" || a.steps.length === 0) {
      return [];
    }
    const v = find(a.steps, a.matter?.id);
    const refs = new Set([v?.id, ...(v?.steps.map((s) => s.ref) ?? [])]);
    return a.steps.every((r) => refs.has(r))
      ? []
      : [oddity(a.id, "its anchors no longer sit in one matter")];
  });

/** Each stopped agent whose matter is running: it still holds it. */
export const stoppedOnRunningOf = (
  agents: readonly HealthAgent[],
  find: Find
) =>
  agents.flatMap((a) => {
    const v = a.status === "stopped" ? find(a.steps, a.matter?.id) : undefined;
    return v && isRunning(v)
      ? [oddity(a.id, `stopped, yet it holds the running matter "${v.name}"`)]
      : [];
  });

/** Each open decision on a matter that is not running: a card on a closed matter. */
export const decisionOnIdleMatterOf = (
  decisions: readonly {
    id: string;
    matter?: string;
    question: string;
    subject?: string;
  }[],
  find: Find
) =>
  decisions.flatMap((d) => {
    const v = d.subject ? find([d.subject], d.matter) : undefined;
    return v && !isRunning(v)
      ? [
          oddity(
            d.id,
            `open on "${v.name}", which is not running: ${d.question}`
          ),
        ]
      : [];
  });

/** What `coverageOf` calls each reason a matter to do is not handed out, in the order of the gates (an array: key order carries no meaning), ending with a matter that passes them all. */
const REASONS: readonly [HandOutGate | null, string][] = [
  ["project_parked", "project parked"],
  ["direction_due", "direction due"],
  ["dismissed", "dismissed"],
  ["held", "held by a stopped or ended agent"],
  ["not_his", "not one of his"],
  ["no_agent", "no agent takes it: no agent of its project, no Personal agent"],
  [null, "ready: waits for the hand-out's pace or his Start"],
];

/**
 * Agent coverage: of the running matters (`matters`, his ranking), how many have a next step to do and how many of
 * those an active agent holds, then for each of the others the first gate it fails (`handOutGateOf`, the hand-out's own
 * rule, so the report never disagrees with it), one row per reason with its matters' names. `facts` are the hand-out's.
 */
export function coverageOf(
  matters: readonly MatterView[],
  facts: HandOutFacts
) {
  const gates = matters.map((v) => [v, handOutGateOf(v, facts)] as const);
  const toDo = gates.filter(([, g]) => g !== "not_do");
  const isActiveHold = (v: MatterView) => facts.isHeld(v)?.status === "active";
  const active = toDo.filter(([v]) => isActiveHold(v));
  const others = toDo.filter(([v]) => !isActiveHold(v));
  return [
    {
      name: "Agent coverage",
      relation: `${toDo.length} of ${matters.length} running matters have a next step to do · ${active.length} held by an active agent`,
    },
    ...REASONS.flatMap(([reason, label]) => {
      const names = others.filter(([, g]) => g === reason).map(([v]) => v.name);
      return names.length > 0
        ? [
            {
              name: `Agent coverage · ${label}`,
              relation: `${names.length}: ${names.join(", ")}`,
            },
          ]
        : [];
    }),
  ];
}

/** The number's row, with last night's when the last `run.end` of the nightly held one (`lastNeedsYou`). */
export const needsYouRowOf = (now: number, lastNeedsYou?: number): Row => ({
  name: "Desk health · needs you",
  relation: `${now} running matters${lastNeedsYou === undefined ? "" : ` (${lastNeedsYou} last night)`}`,
});

/** The health rows, in the report's order: the oddities, the agent coverage, then the number. */
export function healthRowsOf(i: {
  agents: readonly HealthAgent[];
  book: readonly MatterView[];
  decisions: readonly {
    id: string;
    matter?: string;
    question: string;
    subject?: string;
  }[];
  facts: HandOutFacts;
  holds: readonly AgentHold[];
  lastNeedsYou?: number;
  matters: readonly MatterView[];
  needsYou: number;
}) {
  const find = matterFinderOf(i.book);
  return [
    ...activeOnIdleMatterOf(i.agents, find),
    ...heldByTwoOf(i.book, i.holds),
    ...splitAnchorsOf(i.agents, find),
    ...stoppedOnRunningOf(i.agents, find),
    ...decisionOnIdleMatterOf(i.decisions, find),
    ...coverageOf(i.matters, i.facts),
    needsYouRowOf(i.needsYou, i.lastNeedsYou),
  ];
}

/** The number last night's nightly wrote on its `run.end` line: the newest such line of `events` (oldest first, as `recentEvents` gives them) that holds one; undefined when none does. */
export const lastNeedsYouOf = (
  events: readonly { kind: string; needsYou?: unknown; step: string }[]
) =>
  events
    .filter((e) => e.kind === "run.end" && e.step === "memory.nightly")
    .map((e) => e.needsYou)
    .filter((n): n is number => typeof n === "number")
    .at(-1);
