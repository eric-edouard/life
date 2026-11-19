import { clock, DAY, iso } from "../core/clock";
import { holder } from "../core/lock";
import { matterFinderOf } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { readPeople } from "../memory/who";
import { dayNow, localTime } from "../memory/zones";
import {
  type AgentNow,
  activeAgents,
  agentsNow,
  agentsOnProjects,
  agentsOnSteps,
  anchorsOf,
  type DeskRead,
  projectHolderOf,
  readDesk,
  refusedSince,
  reportLinesSince,
} from "./desk-read";

// "What are my agents doing?": every registered agent as read now, as one typed answer (`readRegisteredAgents`) that
// the connector (`read_registered_agents`), the nightly report and his apps (through the connector) share; and the Agents
// parts the matter and area reads show. Reads only; the desk off or its store unreadable is said, never thrown.

/** A registered agent as read now, with the matter its first anchor finds, when its subject is one. */
export type RegisteredAgent = AgentNow & {
  matter: { id: string; name: string; status: string } | null;
};

/**
 * Every registered agent worth showing (`agentsNow`), his changes the desk refused in the last day, whether the desk is
 * on and readable, and whether its helper runs.
 */
export interface RegisteredAgents {
  agents: RegisteredAgent[];
  desk: DeskRead<unknown>["state"];
  helper: "running" | "not running";
  refused: ReturnType<typeof refusedSince>;
  /** Why its store could not be read. */
  why?: string;
}

export async function readRegisteredAgents(
  now = clock()
): Promise<RegisteredAgents> {
  const read = readDesk(
    (db) => ({
      agents: agentsNow(db, now.getTime()),
      refused: refusedSince(db, iso(now.getTime() - DAY)),
    }),
    { agents: [], refused: [] }
  );
  const helper = holder("desk") ? "running" : "not running";
  if (read.state !== "ok") {
    return {
      agents: [],
      desk: read.state,
      helper,
      refused: [],
      ...(read.state === "unreadable" ? { why: read.why } : {}),
    };
  }
  const { agents, refused } = read.value;
  const book = agents.some((a) => a.steps.length > 0)
    ? await readMatterBook(await readPeople(), dayNow())
    : [];
  const find = matterFinderOf(book);
  return {
    agents: agents.map((a) => {
      const v = find(a.steps);
      return {
        ...a,
        matter: v ? { id: v.id, name: v.name, status: v.status } : null,
      };
    }),
    desk: "ok",
    helper,
    refused,
  };
}

/** An agent in two parts: what it works on (with its id and status), then where it stands, what it waits for and until when, its last turn, its link. */
function partsOf(a: AgentNow & { matter?: RegisteredAgent["matter"] }) {
  const last = a.lastTurn;
  return {
    detail: [
      [a.runtime, a.model, a.effort].filter(Boolean).join(" "),
      ...(a.wait
        ? [`waits for ${a.wait.reason} until ${localTime(a.wait.until)}`]
        : []),
      ...(last
        ? [
            `last turn ${last.outcome ?? "running"} ${localTime(last.endedAt ?? last.startedAt)}`,
          ]
        : []),
      ...(a.outcome ? [`ended: ${a.outcome}`] : []),
      ...(a.notStarted ? [`not started: ${a.notStarted}`] : []),
      ...(a.notes ? [`notes: ${a.notes}`] : []),
      ...(a.link ? [a.link] : []),
      ...(a.amber.length > 0 ? [`amber: ${a.amber.join(", ")}`] : []),
    ].join(" · "),
    name: `${a.id} [${a.status}] ${a.matter?.name ?? (a.project ? `project ${a.project}` : a.title)}`,
  };
}

/** One line of an agent (`partsOf`). */
export const agentLine = (a: Parameters<typeof partsOf>[0]) => {
  const { detail, name } = partsOf(a);
  return `${name} · ${detail}`;
};

/** The lines of a read of the desk: nothing while it is off, one line saying so when its store is unreadable. */
const linesOf = (read: DeskRead<AgentNow[]>) => {
  if (read.state === "unreadable") {
    return ["The desk's store could not be read."];
  }
  return read.state === "ok" ? read.value.map((a) => `- ${agentLine(a)}`) : [];
};

/** The Agents part of a matter's read: the agents ever anchored on its steps, active first, then the active agent of each of its `projects`; none while the desk is off or unreadable (`read_registered_agents` says which). */
export function readAgentsOnSteps(steps: string[], projects: string[] = []) {
  const read = readDesk(
    (db) => agentsOnSteps(db, steps, clock().getTime(), projects),
    []
  );
  return read.state === "ok" ? read.value : [];
}

/** The agents on a project (or each project of an area), active first. */
export const agentLinesOnProjects = (projects: string[]) =>
  linesOf(
    readDesk((db) => agentsOnProjects(db, projects, clock().getTime()), [])
  );

/** The active agent holding one of a matter's steps, else the one holding one of its projects (`projectHolderOf`), for `read_matters`: the desk read once for every matter of the call. */
export function readActiveAgentOf() {
  const read = readDesk(
    (db) => {
      const active = activeAgents(db);
      const projects = new Set(active.flatMap((a) => a.project ?? []));
      return {
        byProject: [...projects].map(
          (p) => [p, projectHolderOf(db, p)] as const
        ),
        byStep: active.flatMap((a) =>
          anchorsOf(db, a.id).map((step) => [step, a.id] as const)
        ),
      };
    },
    { byProject: [], byStep: [] }
  );
  const byStep = new Map(read.state === "ok" ? read.value.byStep : []);
  const byProject = new Map(read.state === "ok" ? read.value.byProject : []);
  return (steps: string[], projects: string[]) =>
    steps.map((s) => byStep.get(s)).find(Boolean) ??
    projects.map((p) => byProject.get(p)).find(Boolean) ??
    undefined;
}

/**
 * The nightly report's Agents section: one row per registered agent, then the report lines posted since `since` (the
 * last report), each with its day. Off: none; unreadable: one row saying so.
 */
export async function readAgentRows(since: string) {
  const r = await readRegisteredAgents();
  if (r.desk === "unreadable") {
    return [{ name: "Desk", relation: "its store could not be read" }];
  }
  const lines = readDesk((db) => reportLinesSince(db, since), []);
  return [
    ...(r.desk === "ok" && r.helper === "not running"
      ? [{ name: "Desk", relation: "its helper is not running" }]
      : []),
    ...r.agents.map((a) => {
      const { detail, name } = partsOf(a);
      return { name, relation: detail };
    }),
    ...(lines.state === "ok" ? lines.value : []).map((l) => ({
      name: `${l.source} · ${l.day}`,
      relation: [l.line, ...(l.link ? [l.link] : [])].join(" · "),
    })),
  ];
}
