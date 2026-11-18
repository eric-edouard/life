import { clock } from "../core/clock";
import { holder } from "../core/lock";
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
  readDesk,
  reportLinesSince,
} from "./desk-read";

// "What are my agents doing?": every registered agent as read now, as one typed answer (`readRegisteredAgents`) that
// the connector (`read_registered_agents`), the nightly report and later the apps' local API share; and the Agents
// parts the matter and area reads show. Reads only; the desk off or its store unreadable is said, never thrown.

/** A registered agent as read now, with the matter its first anchor finds, when its subject is one. */
export type RegisteredAgent = AgentNow & {
  matter: { id: string; name: string; status: string } | null;
};

/** Every registered agent worth showing (`agentsNow`), whether the desk is on and readable, and whether its helper runs. */
export interface RegisteredAgents {
  agents: RegisteredAgent[];
  desk: DeskRead<unknown>["state"];
  helper: "running" | "not running";
  /** Why its store could not be read. */
  why?: string;
}

export async function readRegisteredAgents(
  now = clock()
): Promise<RegisteredAgents> {
  const read = readDesk((db) => agentsNow(db, now.getTime()), []);
  const helper = holder("desk") ? "running" : "not running";
  if (read.state !== "ok") {
    return {
      agents: [],
      desk: read.state,
      helper,
      ...(read.state === "unreadable" ? { why: read.why } : {}),
    };
  }
  const book = read.value.some((a) => a.steps.length > 0)
    ? await readMatterBook(await readPeople(), dayNow())
    : [];
  return {
    agents: read.value.map((a) => {
      // Found by its first anchor, then each later one.
      const v = a.steps
        .map((s) => book.find((m) => m.steps.some((x) => x.ref === s)))
        .find(Boolean);
      return {
        ...a,
        matter: v ? { id: v.id, name: v.name, status: v.status } : null,
      };
    }),
    desk: "ok",
    helper,
  };
}

/** One line of an agent: what it works on, where it stands, what it waits for and until when, its last turn, its link. */
export function agentLine(
  a: AgentNow & { matter?: RegisteredAgent["matter"] }
) {
  const last = a.lastTurn;
  return [
    `${a.id} [${a.status}] ${a.matter?.name ?? (a.project ? `project ${a.project}` : a.title)}`,
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
    ...(a.notes ? [`notes: ${a.notes}`] : []),
    ...(a.link ? [a.link] : []),
    ...(a.amber.length > 0 ? [`amber: ${a.amber.join(", ")}`] : []),
  ].join(" · ");
}

/** The lines of a read of the desk: nothing while it is off, one line saying so when its store is unreadable. */
const linesOf = (read: DeskRead<AgentNow[]>) => {
  if (read.state === "unreadable") {
    return ["The desk's store could not be read."];
  }
  return read.state === "ok" ? read.value.map((a) => `- ${agentLine(a)}`) : [];
};

/** The Agents part of a matter's read: the agents ever anchored on its steps, active first. */
export const agentLinesOnSteps = (steps: string[]) =>
  linesOf(readDesk((db) => agentsOnSteps(db, steps, clock().getTime()), []));

/** The agents on a project (or each project of an area), active first. */
export const agentLinesOnProjects = (projects: string[]) =>
  linesOf(
    readDesk((db) => agentsOnProjects(db, projects, clock().getTime()), [])
  );

/** The mark `read_matters` gives a matter an active agent holds, read once for every matter of the call. */
export function readAgentMarks() {
  const read = readDesk(
    (db) =>
      activeAgents(db).flatMap((a) =>
        anchorsOf(db, a.id).map((step) => [step, a.id] as const)
      ),
    []
  );
  const byStep = new Map(read.state === "ok" ? read.value : []);
  return (steps: string[]) => {
    const id = steps.map((s) => byStep.get(s)).find(Boolean);
    return id ? `agent ${id}` : "";
  };
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
      const [name = a.id, ...rest] = agentLine(a).split(" · ");
      return { name, relation: rest.join(" · ") };
    }),
    ...(lines.state === "ok" ? lines.value : []).map((l) => ({
      name: `${l.source} · ${l.day}`,
      relation: [l.line, ...(l.link ? [l.link] : [])].join(" · "),
    })),
  ];
}
