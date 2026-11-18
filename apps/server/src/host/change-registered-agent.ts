import { z } from "zod";
import { DESK_AGENT } from "../core/names";
import { off } from "../core/outputs";
import { readMatterBook } from "../memory/matters";
import { areaFor } from "../memory/read-area-page";
import { loadTruth, type Truth } from "../memory/read-truth";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { AgentChange } from "../records/registered-agent";
import { listRepos } from "../sources/git";
import { ask } from "./asks";
import { requested } from "./change-todo-item";
import { agentChangeOf, readDesk } from "./desk-read";

// His word about a registered agent, from a chat (`change_registered_agent`): one ask of the desk (`DESK_AGENT`) in
// the ledger, with the change it names (`after.agentChange`). The connector starts nothing: the desk applies it within a
// tick (`desk/agent-changes.ts`), and this waits a few seconds for what it did. Only Life-side facts are checked here
// (his subject's matter or project); which agent, its status, the runtime and the folder are the desk's.

/** What the connector takes: the change, with a matter named by any of its ids (`step`), and his words. */
export const RegisteredAgentChange = AgentChange.omit({ steps: true }).extend({
  action: AgentChange.shape.action.describe(
    "start (on `step` or `project`; `folder`, else its project's repo, else its own), stop, resume, re_point (a new `step` or `project`), change_model, hand_over (to another `runtime`)"
  ),
  agent: AgentChange.shape.agent.describe("The agent (agt_…), all but start"),
  effort: AgentChange.shape.effort.describe(
    "Its effort, when its runtime takes one (start, change_model); none: the desk's default"
  ),
  folder: AgentChange.shape.folder.describe(
    "Where its sessions start, an absolute folder (start); none: its project's repo on the Mac, else a folder of its own"
  ),
  model: AgentChange.shape.model.describe(
    "Its model (start, change_model); none: the desk's default for its runtime"
  ),
  project: AgentChange.shape.project.describe(
    "A project id or name of his directory, as its subject"
  ),
  runtime: AgentChange.shape.runtime.describe(
    "claude, codex or dsh; none: the desk's default"
  ),
  said: z
    .string()
    .min(1)
    .max(8000)
    .describe("His own words, verbatim: a start's are its brief"),
  step: z
    .string()
    .min(1)
    .optional()
    .describe("A matter's id, or one of its steps' ids, as its subject"),
});
export type RegisteredAgentChange = z.infer<typeof RegisteredAgentChange>;

/** How long the connector waits for the desk to apply his word: past it, it says the desk has not acted yet. */
const WAIT_MS = 12_000;
const POLL_MS = 500;

/** The matter `step` names (its id, or a step's): its anchors (that step first, then the rest of its steps) and its projects. */
async function matterNamed(step: string) {
  const book = await readMatterBook(await readPeople(), dayNow());
  const v =
    book.find((m) => m.id === step) ??
    book.find((m) => m.steps.some((s) => s.ref === step));
  if (!v) {
    throw new Error(`Not done: no matter ${step}.`);
  }
  const refs = v.steps.map((s) => s.ref);
  return {
    projects: v.projects,
    steps: refs.includes(step)
      ? [step, ...refs.filter((r) => r !== step)]
      : refs,
  };
}

/**
 * Where a new agent's sessions start when he names no folder: the first of its `projects`' repos cloned on the Mac,
 * from his directory's `repos:` only (never Life's guessed repos: an agent runs where he said the project lives), by its key as the repo map reads it (`owner/name` is on GitHub only); none: the desk
 * makes a folder of its own for it.
 */
function repoFolderOf(projects: string[], truth: Truth) {
  const here = new Map(listRepos().map((r) => [r.key, r.path]));
  return projects
    .flatMap((id) => truth.projects.find((p) => p.id === id)?.repos ?? [])
    .map((repo) => here.get(repo))
    .find(Boolean);
}

/**
 * His change with its Life-side facts read: his project's id, the matter's anchors and, for a start with no folder,
 * the folder of its project's repo (`repoFolderOf`). Throws when the project or the matter is not his.
 */
async function withSubject({
  step,
  ...rest
}: Omit<RegisteredAgentChange, "said">): Promise<AgentChange> {
  const change: AgentChange = { ...rest };
  const hasNoFolder = change.action === "start" && !change.folder;
  const truth = rest.project || hasNoFolder ? await loadTruth() : undefined;
  if (rest.project && truth) {
    const { project } = areaFor(rest.project, truth);
    if (!project) {
      throw new Error(`Not done: no project ${rest.project}.`);
    }
    change.project = project.id;
  }
  const matter = step ? await matterNamed(step) : undefined;
  change.steps = matter?.steps;
  if (hasNoFolder && truth) {
    change.folder = repoFolderOf(
      [
        ...(matter?.projects ?? []),
        ...(change.project ? [change.project] : []),
      ],
      truth
    );
  }
  return change;
}

/** Records his word as an ask of the desk, then waits for what the desk did with it: done, refused, or not yet. */
export async function changeRegisteredAgent({
  said,
  ...rest
}: RegisteredAgentChange) {
  const why = off("desk");
  if (why) {
    throw new Error(`Not done: ${why}`);
  }
  const change = await withSubject(rest);
  const line = ask(
    requested("connector", said),
    { agent: DESK_AGENT, agentChange: change, confidence: "high" },
    "connector",
    "asked in a chat"
  );
  for (let waited = 0; waited < WAIT_MS; waited += POLL_MS) {
    const read = readDesk((db) => agentChangeOf(db, line.id), null);
    const done = read.state === "ok" ? read.value : null;
    if (done?.error) {
      throw new Error(`Not done: ${done.error}.`);
    }
    if (done) {
      return `Done: ${change.action} ${done.agent_id ?? ""}`.trim();
    }
    // biome-ignore lint/performance/noAwaitInLoops: polls the desk's answer
    await Bun.sleep(POLL_MS);
  }
  return `Recorded (${line.id}); the desk has not acted on it yet: \`read_registered_agents\` shows the agent once it has, or under \`refused\` why not.`;
}
