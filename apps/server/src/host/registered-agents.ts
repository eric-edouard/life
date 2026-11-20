import { clock, DAY, iso } from "../core/clock";
import { DEFAULT_RADIUS_M } from "../core/distance";
import { holder } from "../core/lock";
import type { SourceName } from "../core/names";
import { decisionsNow } from "../memory/decisions";
import { matterFinderOf } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { sourceOf } from "../memory/sources";
import { meant, type People, readPeople } from "../memory/who";
import { dayNow, localDate, localTime } from "../memory/zones";
import type { EventFilter } from "../records/registered-agent";
import {
  type AgentNow,
  type AgentRead,
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
  type TurnTokens,
  tokensSince,
} from "./desk-read";
import { EVENT_CHANNELS, type EventChannel } from "./event-channels";
import { matcherOf } from "./events";

// "What are my agents doing?": every registered agent as read now, as one typed answer (`readRegisteredAgents`) that
// the connector (`read_registered_agents`), the nightly report and his apps (through the connector) share; and the Agents
// parts the matter and area reads show. Reads only; the desk off or its store unreadable is said, never thrown.

/**
 * One line of what will wake an agent (`wakesOnOf`), beside its deadline (`wait.until`): `kind` is `message` (a message,
 * and with `calls` the calls of the same people or chat), an event channel's name (`payments`, `places`), `answer` (his answer to
 * its open card, or its deadline) or `wide_net` (anything new close to its matter). Only the fields a kind has.
 */
interface ListenLine {
  above?: number;
  /** The apps a message line is limited to; none: every app. */
  apps?: string[];
  below?: number;
  /** Why the line can never fire, as a code the app words: `unknown_person` (the filter's `person`, kept as written, no longer resolves). */
  broken?: "unknown_person";
  /** Whether the line also covers calls (a call has no text and is never his own). */
  calls?: boolean;
  chat?: { app: string | null; group: boolean | null; name: string | null };
  fromHim?: true;
  kind: string;
  /** The place an event channel's line is limited to (a channel whose events hold a point). */
  near?: { latitude: number; longitude: number; radius_m: number };
  person?: string;
  quantity?: string;
  words?: string;
}

/** His answer to the agent's open card, or the card's deadline (always set). */
interface AnswerLine {
  card: string;
  check: string;
  deadline: string;
  kind: "answer";
}

export type WakeLine = AnswerLine | ListenLine;

/** What `wakesOnOf` reads besides the filters: the event channels, who people are, the chats the agent has heard from, its open card and whether it has a wide net. */
export interface WakesOnContext {
  card?: { check: string; deadline: string; question: string };
  channels: Pick<EventChannel, "hasPoint" | "name" | "quantities">[];
  hasNet: boolean;
  people: People;
  seen: AgentRead["chatsSeen"];
}

/** A message filter's chat as shown: its name from his directory, else from the agent's own newest event there; its app, when the filter names one, else that event's; whether it is a group by its app's own rule. */
function chatOf(
  key: string,
  apps: string[] | undefined,
  { people, seen }: WakesOnContext
) {
  const known = people.truth.chats.find(
    (c) => c.id === key || c.whatsapp === key
  );
  const app = apps?.length === 1 ? apps[0] : seen[key]?.source;
  return {
    app: app ?? null,
    group: app ? (sourceOf(app as SourceName)?.group?.(key) ?? null) : null,
    name: known?.name ?? seen[key]?.name ?? null,
  };
}

/** The place `f` names, or none. */
const placeOf = ({ latitude, longitude, radius_m }: EventFilter) =>
  latitude === undefined || longitude === undefined
    ? undefined
    : { latitude, longitude, radius_m: radius_m ?? DEFAULT_RADIUS_M };

/** The message line of `f` (its messages, and calls when it covers them), none when `f` stops every message (a `quantity`, a place, or only event channels). */
function messageLineOf(f: EventFilter, c: WakesOnContext): ListenLine[] {
  const { channels, people } = c;
  const apps = f.channels?.filter((n) => !channels.some((x) => x.name === n));
  if (f.quantity || placeOf(f) || apps?.length === 0) {
    return [];
  }
  const known = f.person ? meant(f.person, people).known : undefined;
  return [
    {
      ...(apps ? { apps } : {}),
      ...(f.person && matcherOf(f, people) === null
        ? { broken: "unknown_person" as const }
        : {}),
      calls: !(f.text_matches || f.from_me),
      ...(f.chat ? { chat: chatOf(f.chat, apps, c) } : {}),
      ...(f.from_me ? { fromHim: true as const } : {}),
      kind: "message",
      ...(f.person
        ? { person: known ? people.nameOf(`person:${known}`) : f.person }
        : {}),
      ...(f.text_matches ? { words: f.text_matches } : {}),
    },
  ];
}

/** The event channel lines of `f`: one per channel it names whose events can match it (a quantity it holds, a point when `f` names a place); none when `f` names a message's keys. */
function eventLinesOf(
  f: EventFilter,
  channels: WakesOnContext["channels"]
): ListenLine[] {
  const near = placeOf(f);
  if (f.person || f.chat || f.from_me) {
    return [];
  }
  return channels
    .filter(
      (x) =>
        f.channels?.includes(x.name) &&
        (!f.quantity || x.quantities.includes(f.quantity)) &&
        (!near || x.hasPoint)
    )
    .map((x) => ({
      ...(f.quantity ? { quantity: f.quantity } : {}),
      ...(f.quantity && f.above !== undefined ? { above: f.above } : {}),
      ...(f.quantity && f.below !== undefined ? { below: f.below } : {}),
      kind: x.name,
      ...(near ? { near } : {}),
      ...(f.text_matches ? { words: f.text_matches } : {}),
    }));
}

/**
 * What will wake an agent waiting on `filters`, one line per filter that can fire (a filter naming message apps and an
 * event channel gives a line for each side), in its order, then its open card, then its wide net. The rules are
 * `matcherOf`'s over `Matchable`: a `quantity` or a place stops every message (a place, every event with no point), a
 * `person`, `chat` or `from_me` every event channel's event, and a person no one goes by never matches (`broken`).
 */
export function wakesOnOf(
  filters: EventFilter[],
  c: WakesOnContext
): WakeLine[] {
  const { card, channels, hasNet } = c;
  const lines = filters.flatMap((f): ListenLine[] => [
    ...messageLineOf(f, c),
    ...eventLinesOf(f, channels),
  ]);
  return [
    ...lines,
    ...(card
      ? [
          {
            card: card.question,
            check: card.check,
            deadline: card.deadline,
            kind: "answer" as const,
          },
        ]
      : []),
    ...(hasNet ? [{ kind: "wide_net" }] : []),
  ];
}

/** `agents` without what only `wakesOn` is made of, with it: its lines while it waits, none otherwise (running, stopped, ended). `people` is read once by the caller; the wide net is only for an agent whose matter is found (`hasMatter`, as `netsOf` decides). */
function withWakesOn(
  agents: AgentRead[],
  people: People,
  hasMatter: (steps: string[]) => boolean
) {
  const open = decisionsNow().filter((d) => d.state === "open");
  return agents.map(({ chatsSeen, filters, ...a }) => {
    const d = open.find((x) => x.agent === a.id);
    return {
      ...a,
      wakesOn:
        a.status === "waiting"
          ? wakesOnOf(filters, {
              card: d && {
                check: d.id,
                deadline: d.deadline,
                question: d.question,
              },
              channels: EVENT_CHANNELS,
              hasNet: hasMatter(a.steps),
              people,
              seen: chatsSeen,
            })
          : [],
    };
  });
}

/** A registered agent as read now, with what will wake it, and the matter its first anchor finds, when its subject is one. */
export type RegisteredAgent = ReturnType<typeof withWakesOn>[number] & {
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
      agents: agentsNow(db, now.getTime(), true),
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
  const { refused } = read.value;
  const people = await readPeople();
  const book = read.value.agents.some((a) => a.steps.length > 0)
    ? await readMatterBook(people, dayNow())
    : [];
  const find = matterFinderOf(book);
  const agents = withWakesOn(read.value.agents, people, (steps) =>
    Boolean(find(steps))
  );
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
export function readAgentsOnSteps(
  steps: string[],
  projects: string[],
  people: People
) {
  const read = readDesk(
    (db) => agentsOnSteps(db, steps, clock().getTime(), projects, true),
    []
  );
  // The matter is the one read, found: an agent anchored on it has its wide net.
  return read.state === "ok"
    ? withWakesOn(read.value, people, (s) => s.length > 0)
    : [];
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

/** The tokens of agents' turns as report rows: one per local day of his (`localDate`), then one per matter (`matterOf`: an agent's matter name, else "no matter"). Pure; every row. */
export function tokenRowsOf(
  turns: readonly TurnTokens[],
  matterOf: (agentId: string) => string
) {
  // The key's first character sorts days (1) before matters (2).
  const sums = new Map<string, number[]>();
  const add = (key: string, t: TurnTokens) => {
    const [i = 0, c = 0, o = 0] = sums.get(key) ?? [];
    sums.set(key, [i + t.tokens_in, c + t.tokens_cached, o + t.tokens_out]);
  };
  for (const t of turns) {
    add(`1${localDate(t.started_at)}`, t);
    add(`2${matterOf(t.agent_id)}`, t);
  }
  return [...sums]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, [i, c, o]]) => ({
      name: `Tokens · ${key.slice(1)}`,
      relation: `${i} in (${c} cached) · ${o} out`,
    }));
}

/**
 * The nightly report's Agents section: one row per registered agent, then the report lines posted since `since` (the
 * last report), each with its day, then the tokens of the agents' turns since then (`tokenRowsOf`). Off: none; unreadable: one row saying so.
 */
export async function readAgentRows(since: string) {
  const r = await readRegisteredAgents();
  if (r.desk === "unreadable") {
    return [{ name: "Desk", relation: "its store could not be read" }];
  }
  const lines = readDesk((db) => reportLinesSince(db, since), []);
  const tokens = await readTokenRows(since);
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
    ...tokens,
  ];
}

async function readTokenRows(since: string) {
  const read = readDesk((db) => {
    const turns = tokensSince(db, since);
    const agents = [...new Set(turns.map((t) => t.agent_id))];
    return {
      anchors: agents.map((id) => [id, anchorsOf(db, id)] as const),
      turns,
    };
  }, null);
  if (read.state !== "ok" || !read.value || read.value.turns.length === 0) {
    return [];
  }
  const anchors = new Map(read.value.anchors);
  const find = matterFinderOf(
    await readMatterBook(await readPeople(), dayNow())
  );
  return tokenRowsOf(
    read.value.turns,
    (id) => find(anchors.get(id) ?? [])?.name ?? "no matter"
  );
}
