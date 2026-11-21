import { z } from "zod";
import { clock } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { off } from "../core/outputs";
import { matterOfSteps } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { recordCorrection } from "../memory/memory-files";
import { areaFor } from "../memory/read-area-page";
import { loadTruth, type Truth } from "../memory/read-truth";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { GoalText } from "../records/matter";
import { AgentChange } from "../records/registered-agent";
import { listRepos } from "../sources/git";
import { ask } from "./asks";
import { requested } from "./change-todo-item";
import {
  agentChangeOf,
  holderOf,
  modelOf,
  readDesk,
  readStartFacts,
  runtimeOf,
  standingAgents,
} from "./desk-read";
import type { ToolCall } from "./http/mcp-tool";

// His word about a registered agent, from a chat (`change_registered_agent`): one ask of the desk (`DESK_AGENT`) in
// the ledger, with the change it names (`after.agentChange`). The connector starts nothing: the desk applies it within a
// tick (`desk/agent-changes.ts`), and this waits a few seconds for what it did. Only Life-side facts are checked here
// (his subject's matter or project); which agent, its status, the runtime and the folder are the desk's.

/** What the connector takes: the change, with a matter named by any of its ids (`step`), and his words. */
export const RegisteredAgentChange = AgentChange.omit({
  matter: true,
  steps: true,
}).extend({
  action: AgentChange.shape.action.describe(
    "start (on `step`: the matter goes to the agent that takes it, its project's, else the Personal agent; on `project`: a new agent, in `folder`, else its project's repo, else its own; or `role` `personal`: the Personal agent, in its home), stop, resume, re_point (a new `step`, `project` or `role` `personal`), rename (`name`), change_model, hand_over (a move: `step` with `runtime`, the matter to a new agent of its own there, its old agent writing its notes first; `step` with `agent`, the matter to that agent; or `agent` with `runtime`, the whole agent to that runtime; answered at once with the move's id, its phase then on `read_matter`'s `move` or the agent's `switch`)"
  ),
  agent: AgentChange.shape.agent.describe(
    "The agent (agt_…), all but start; with hand_over and a `step`, the agent the matter moves to"
  ),
  effort: AgentChange.shape.effort.describe(
    "Its effort, when its runtime takes one (start, change_model); none: the desk's default"
  ),
  folder: AgentChange.shape.folder.describe(
    "Where its sessions start, an absolute folder (start); none: its project's repo on the Mac, else a folder of its own"
  ),
  model: AgentChange.shape.model.describe(
    "Its model (start, change_model); none: the desk's default for its runtime"
  ),
  name: AgentChange.shape.name.describe(
    'Its name, his to set (start, rename): its sessions are titled "Agent: <name>"'
  ),
  project: AgentChange.shape.project.describe(
    "A project id or name of his directory, as its subject"
  ),
  role: AgentChange.shape.role.describe(
    '"personal": the Personal agent, as its subject (start, re_point): one at most; it takes every matter no project\'s agent takes'
  ),
  runtime: AgentChange.shape.runtime.describe(
    "claude, codex or pi; none: the desk's default"
  ),
  said: z
    .string()
    .min(1)
    .max(8000)
    .describe(
      "His own words, verbatim: a start's are its brief, and on a matter its goal (at most 200 characters)"
    ),
  step: z
    .string()
    .min(1)
    .optional()
    .describe("A matter's id, or one of its steps' ids, as its subject"),
});
export type RegisteredAgentChange = z.infer<typeof RegisteredAgentChange>;

/** How long the connector waits for the desk to apply his word (a start: its three stages): past it, `unconfirmed`. A tick is 5 s and may sit inside a 30 s message poll, so 15 s shows healthy starts unconfirmed. */
export const WAIT_MS = 20_000;
const POLL_MS = 500;

/** The matter `step` names (its id, or a step's): its anchors (that step first, then the rest of its steps), its steps as listed and its goal. */
async function matterNamed(step: string) {
  const v = matterOfSteps(await readMatterBook(await readPeople(), dayNow()), [
    step,
  ]);
  if (!v) {
    throw new Error(`Not done: no matter ${step}.`);
  }
  const refs = v.steps.map((s) => s.ref);
  return {
    goal: v.goal,
    id: v.id,
    refs,
    steps: refs.includes(step)
      ? [step, ...refs.filter((r) => r !== step)]
      : refs,
  };
}

/**
 * Where a project's new agent's sessions start when he names no folder: the first of its repos cloned on the Mac, from
 * his directory's `repos:` only (never Life's guessed repos: an agent runs where he said the project lives), by its key
 * as the repo map reads it (`owner/name` is on GitHub only); none: the desk makes a folder of its own for it.
 */
function readRepoFolder(project: Truth["projects"][number]) {
  const here = new Map(listRepos().map((r) => [r.key, r.path]));
  return project.repos.map((repo) => here.get(repo)).find(Boolean);
}

/**
 * His change with its Life-side facts read: his project's id, the matter's anchors and, for a project's start with no
 * folder, the folder of its repo (`readRepoFolder`); and the matter named. Throws when the project or the matter is not his.
 */
async function withSubject({
  step,
  ...rest
}: Omit<RegisteredAgentChange, "said">) {
  const change: AgentChange = { ...rest };
  if (rest.project) {
    const { project } = areaFor(rest.project, await loadTruth());
    if (!project) {
      throw new Error(`Not done: no project ${rest.project}.`);
    }
    change.project = project.id;
    if (change.action === "start" && !change.folder) {
      change.folder = readRepoFolder(project);
    }
  }
  const matter = step ? await matterNamed(step) : undefined;
  change.steps = matter?.steps;
  change.matter = matter?.id;
  return { change, matter };
}

/** A matter start's words become his goal for it (his `matter-direction`, pinned to its steps), unless they already are. */
async function saveGoal(
  matter: Awaited<ReturnType<typeof matterNamed>>,
  said: string
) {
  if (!GoalText.safeParse(said).success) {
    throw new Error(
      "Not done: on a matter, `said` is its goal too: at most 200 characters."
    );
  }
  if (!(matter.goal?.by === "owner" && matter.goal.text === said)) {
    await recordCorrection({
      goal: said,
      kind: "matter-direction",
      matter: matter.id,
      steps: matter.refs,
    });
  }
}

/** What the connector reports for a start, in order: the desk's three facts (a matter start's `goal_saved` comes before them). */
export const START_STAGES = [
  "desk_accepted",
  "session_open",
  "turn_begun",
] as const;

/** The start's stages as the desk's store has written them so far (`readStartFacts`): each with its time and detail. */
function stagesOf(s: ReturnType<typeof readStartFacts>) {
  const { change, session, turn } = s;
  return [
    ...(change?.agent_id && !change.error
      ? [
          {
            agent: change.agent_id,
            at: change.applied_at,
            stage: START_STAGES[0],
          },
        ]
      : []),
    ...(session
      ? [
          {
            at: session.started_at,
            link: session.link,
            session: session.ref,
            stage: START_STAGES[1],
          },
        ]
      : []),
    ...(turn?.begun_at ? [{ at: turn.begun_at, stage: START_STAGES[2] }] : []),
  ];
}

/** Why a start did not happen, from what the desk wrote: its refusal, or the agent it ended before its first turn began. */
function startFailure(s: ReturnType<typeof readStartFacts>) {
  if (s.change?.error) {
    return s.change.error;
  }
  return s.assignment?.why_not_started ?? null;
}

/** A start's answer from the facts read: `started`, `not_started` (refused, or its agent ended before it began) or `unconfirmed`. */
function startResult(
  s: ReturnType<typeof readStartFacts> | null,
  isSubjectHeld: boolean,
  stages: ReturnType<typeof stagesOf>,
  askId: string,
  change: AgentChange,
  limitMs: number
) {
  const reason = s ? startFailure(s) : null;
  const isStarted = stages.length === START_STAGES.length;
  let state = "unconfirmed";
  if (reason) {
    state = "not_started";
  } else if (isStarted) {
    state = "started";
  }
  return {
    action: "start",
    agent: s?.agent?.id ?? null,
    ask: askId,
    failed: isStarted
      ? null
      : {
          reason: reason ?? `no answer from the desk in ${limitMs / 1000} s`,
          stage: START_STAGES[stages.length] ?? START_STAGES[2],
        },
    model: s?.agent ? modelOf(s.agent).model : (change.model ?? null),
    // A subject held by an active agent has one running.
    nothingRunning: state === "not_started" && !isSubjectHeld,
    runtime: s?.agent?.runtime ?? runtimeOf(change) ?? null,
    stages,
    state,
  };
}

/** A start: reports each stage once as its fact appears, ends at the last, a refusal, or the limit. */
async function waitForStart(
  line: { id: string },
  change: AgentChange,
  { report }: ToolCall,
  limitMs: number
) {
  let reported = 0;
  for (let waited = 0; ; waited += POLL_MS) {
    const read = readDesk(
      (db) => ({
        isSubjectHeld: change.steps
          ? holderOf(db, change.steps) !== null
          : standingAgents(db).some((a) =>
              change.role
                ? a.role === change.role
                : a.project === change.project
            ),
        s: readStartFacts(db, line.id, change),
      }),
      null
    );
    const { isSubjectHeld, s } =
      read.state === "ok" && read.value
        ? read.value
        : { isSubjectHeld: false, s: null };
    const stages = s ? stagesOf(s) : [];
    for (const { stage, ...detail } of stages.slice(reported)) {
      report({ step: stage, ...detail });
    }
    reported = stages.length;
    if (
      reported === START_STAGES.length ||
      (s && startFailure(s)) ||
      waited >= limitMs
    ) {
      return startResult(s, isSubjectHeld, stages, line.id, change, limitMs);
    }
    // biome-ignore lint/performance/noAwaitInLoops: polls the desk's facts
    await Bun.sleep(POLL_MS);
  }
}

/** Any other action: done when the desk applied it, refused with its reason (a throw), or not yet. */
async function waitForChange(
  line: { id: string },
  change: AgentChange,
  limitMs: number
) {
  for (let waited = 0; waited < limitMs; waited += POLL_MS) {
    const read = readDesk((db) => agentChangeOf(db, line.id), null);
    const done = read.state === "ok" ? read.value : null;
    if (done?.error) {
      throw new Error(`Not done: ${done.error}.`);
    }
    if (done) {
      return {
        action: change.action,
        agent: done.agent_id ?? change.agent ?? null,
        state: "done",
      };
    }
    // biome-ignore lint/performance/noAwaitInLoops: polls the desk's answer
    await Bun.sleep(POLL_MS);
  }
  return {
    action: change.action,
    agent: change.agent ?? null,
    state: "unconfirmed",
  };
}

/**
 * Records his word as an ask of the desk, then reports what the desk did with it (JSON): a start's stages, each as its
 * fact is written (`report`), then `started`, `not_started` or `unconfirmed`; another change `done`, `unconfirmed`, or
 * refused (a throw). A start on a matter first saves his words as its goal (`goal_saved`): the one place a start's goal
 * is written. Each call is a new ask: a repeated start for a matter its agent already holds answers with that agent.
 * `tellLifeRef`: his words came through Tell Life (the main session's door), the ask's ref (`tellLifeRefOf`).
 */
export async function changeRegisteredAgent(
  { said, ...rest }: RegisteredAgentChange,
  call: ToolCall = { report: () => undefined },
  limitMs = WAIT_MS,
  tellLifeRef?: string
) {
  const why = off("desk");
  if (why) {
    throw new Error(`Not done: ${why}`);
  }
  const { change, matter } = await withSubject(rest);
  const isStart = change.action === "start";
  if (isStart) {
    call.report({
      limitSeconds: limitMs / 1000,
      plan: [...(matter ? ["goal_saved"] : []), ...START_STAGES],
    });
    if (matter) {
      await saveGoal(matter, said);
      call.report({ at: clock().toISOString(), step: "goal_saved" });
    }
  }
  const line = ask(
    tellLifeRef
      ? { at: clock().toISOString(), quote: said, ref: tellLifeRef }
      : requested("connector", said),
    { agent: DESK_AGENT, agentChange: change, confidence: "high" },
    "connector",
    tellLifeRef ? "asked through Tell Life" : "asked in a chat"
  );
  if (change.action === "hand_over") {
    // A move takes minutes (the old agent's notes, the new one's start): its phase is read, never waited for here.
    return {
      action: "hand_over",
      agent: change.agent ?? null,
      move: line.id,
      state: "asked",
    };
  }
  return isStart
    ? waitForStart(line, change, call, limitMs)
    : waitForChange(line, change, limitMs);
}
