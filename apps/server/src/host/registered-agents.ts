import { clock, DAY, iso } from "../core/clock";
import { DEFAULT_RADIUS_M } from "../core/distance";
import { holder } from "../core/lock";
import type { SourceName } from "../core/names";
import { decisionsNow, openDecisionOf } from "../memory/decisions";
import { isHeldOf } from "../memory/held-matters";
import {
  type MatterView,
  matterFinderOf,
  nextStepNow,
} from "../memory/matter-read";
import { readMatterBook, readMatterBookAndRecords } from "../memory/matters";
import type { Party } from "../memory/party";
import { readHandOutMatters } from "../memory/read-matters";
import { sourceOf } from "../memory/sources";
import { meant, type People, readPeople } from "../memory/who";
import { dayNow, localDate, localTime } from "../memory/zones";
import type { EventFilter } from "../records/registered-agent";
import { healthRowsOf } from "./desk-health";
import {
  type AgentNow,
  type AgentRead,
  agentsNow,
  agentsOnProjects,
  agentsOnSteps,
  anchorsOf,
  currentAssignmentOf,
  type DeskRead,
  handedOutAgentsSince,
  heldByAgents,
  openAssignments,
  projectHolderOf,
  readDesk,
  refusedSince,
  reportLinesSince,
  type TurnTokens,
  tokensSince,
} from "./desk-read";
import { EVENT_CHANNELS, type EventChannel } from "./event-channels";
import { matcherOf } from "./events";
import { openChecksNow } from "./inbox";
import { matterRowsNowOf } from "./matter-rows";

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
  /** Why the line can never fire, as a code the app words: `unknown_person` (the filter's `person`, `personAsWritten`, no longer resolves). */
  broken?: "unknown_person";
  /** Whether the line also covers calls (a call has no text and is never his own). */
  calls?: boolean;
  chat?: { app: string | null; group: boolean | null; name: string | null };
  fromHim?: true;
  kind: string;
  /** The place an event channel's line is limited to (a channel whose events hold a point). */
  near?: { latitude: number; longitude: number; radius_m: number };
  /** Who the filter's `person` is now, when it resolves (`partyOf`). */
  party?: Party;
  /** The filter's `person` as the agent wrote it, always beside `party`: the words to show when it no longer resolves. */
  personAsWritten?: string;
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
      ...(known ? { party: people.partyOf(`person:${known}`) } : {}),
      ...(f.person ? { personAsWritten: f.person } : {}),
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
  hasMatter: (steps: string[]) => boolean,
  decisions = decisionsNow()
) {
  return agents.map(({ chatsSeen, ...a }) => {
    const d = openDecisionOf(a.id, decisions);
    return {
      ...a,
      wakesOn:
        a.status === "waiting"
          ? wakesOnOf(a.wait?.events ?? [], {
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
  now = clock(),
  /** The people, the matter book and the decisions, when the caller read them already (the report reads them once). */
  given?: {
    book: readonly MatterView[];
    decisions: ReturnType<typeof decisionsNow>;
    people: People;
  }
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
  const people = given?.people ?? (await readPeople());
  const book =
    given?.book ??
    (read.value.agents.some((a) => a.steps.length > 0)
      ? await readMatterBook(people, dayNow())
      : []);
  const find = matterFinderOf(book);
  const agents = withWakesOn(
    read.value.agents,
    people,
    (steps) => Boolean(find(steps)),
    given?.decisions
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
      const projects = new Set(
        db
          .query<{ project: string }, []>(
            "select distinct project from agent where status = 'active' and project is not null"
          )
          .all()
          .map((r) => r.project)
      );
      return {
        byProject: [...projects].map(
          (p) => [p, projectHolderOf(db, p)] as const
        ),
        byStep: openAssignments(db).flatMap((s) =>
          anchorsOf(db, s.id).map((step) => [step, s.agent_id] as const)
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

/** The tokens of agents' turns as report rows: one per local day of his (`localDate` of the turn's end), then one per matter (`matterOf`: an agent's matter, else null: "no matter"), keyed by the matter's id. Pure; every row. */
export function tokenRowsOf(
  turns: readonly TurnTokens[],
  matterOf: (agentId: string) => { id: string; name: string } | undefined
) {
  // The key's first character sorts days (1) before matters (2).
  const sums = new Map<string, number[]>();
  const names = new Map<string, string>();
  const add = (key: string, t: TurnTokens) => {
    const [i = 0, c = 0, o = 0] = sums.get(key) ?? [];
    sums.set(key, [i + t.tokens_in, c + t.tokens_cached, o + t.tokens_out]);
  };
  for (const t of turns) {
    add(`1${localDate(t.ended_at)}`, t);
    const m = matterOf(t.agent_id);
    names.set(`2${m?.id ?? ""}`, m?.name ?? "no matter");
    add(`2${m?.id ?? ""}`, t);
  }
  return [...sums]
    .toSorted(([a], [b]) => (a < b ? -1 : 1))
    .map(([key, [i, c, o]]) => ({
      name: `Tokens · ${names.get(key) ?? key.slice(1)}`,
      relation: `${i} in (${c} cached) · ${o} out`,
    }));
}

/**
 * The nightly report's Agents section: one row per registered agent, then the report lines posted since `since` (the
 * last report), each with its day, then the hand-outs (`handOutRowsOf`), the tokens of the agents' turns since then
 * (`tokenRowsOf`), and the desk health rows (`healthRowsOf`: oddities, agent coverage, the number of matters that need
 * him, with last night's). Off: none; unreadable: one row saying so. The matter book and the records are read once
 * for all of them; `needsYou` is the number, for the night's `run.end` (undefined while the desk is not readable).
 */
export async function readAgentSection(since: string, lastNeedsYou?: number) {
  // The desk first: off, nothing is read; unreadable, one row says so.
  const desk = readDesk((db) => heldByAgents(db), []);
  if (desk.state !== "ok") {
    return {
      needsYou: undefined,
      rows:
        desk.state === "unreadable"
          ? [{ name: "Desk", relation: "its store could not be read" }]
          : [],
    };
  }
  const people = await readPeople();
  // A book that cannot be read costs the oddities, coverage and number, never the agents' rows.
  const read = await readMatterBookAndRecords(people, dayNow()).catch(
    () => undefined
  );
  const book = read?.book ?? [];
  const decisions = decisionsNow();
  const r = await readRegisteredAgents(clock(), { book, decisions, people });
  const lines = readDesk((db) => reportLinesSince(db, since), []);
  const tokens = readDeskRows(since, book, decisions);
  const health = read
    ? await readHealth(read, people, r, lastNeedsYou)
    : undefined;
  return {
    needsYou: health?.needsYou,
    rows: [
      ...(r.helper === "not running"
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
      ...(health?.rows ?? []),
    ],
  };
}

/** The desk health rows and the number (`healthRowsOf`) over the book, records and people already read, the holds in the desk's store and his open checks. */
async function readHealth(
  read: Awaited<ReturnType<typeof readMatterBookAndRecords>>,
  people: People,
  r: RegisteredAgents,
  lastNeedsYou?: number
) {
  const { facts, matters } = await readHandOutMatters(
    async () => ({ book: [...read.book], records: read.records }),
    people
  );
  const holds = readDesk((db) => heldByAgents(db), []);
  const needsYou = matterRowsNowOf(
    matters.map((v) => ({
      id: v.id,
      nextStep: nextStepNow(v, facts.decisions),
      status: v.status,
    })),
    await openChecksNow()
  ).filter((row) => row.needsYou).length;
  return {
    needsYou,
    rows: healthRowsOf({
      agents: r.agents,
      book: read.book,
      decisions: facts.decisions,
      facts: {
        ...facts,
        isHeld: isHeldOf(holds.state === "ok" ? holds.value : []),
      },
      holds: holds.state === "ok" ? holds.value : [],
      lastNeedsYou,
      matters,
      needsYou,
    }),
  };
}

/** The hand-outs since the last report as rows: how many started and how many have an answered card, then each that never began, or ended having never asked a card (`everAsked`: a card withdrawn at its end still counts, unlike the door's `hasAsked`), by its matter's name. Pure; every row; none when nothing was handed out. */
export function handOutRowsOf(
  agents: readonly {
    id: string;
    status: string;
    why_not_started: string | null;
  }[],
  cards: { answered: ReadonlySet<string>; everAsked: ReadonlySet<string> },
  matterOf: (agentId: string) => { name: string } | undefined
) {
  if (agents.length === 0) {
    return [];
  }
  return [
    {
      name: "Hand-outs",
      relation: `${agents.length} started · ${agents.filter((a) => cards.answered.has(a.id)).length} with an answered card`,
    },
    ...agents.flatMap((a) => {
      const why =
        a.why_not_started === null
          ? a.status === "ended" &&
            !cards.everAsked.has(a.id) &&
            "ended with no card"
          : `never began: ${a.why_not_started}`;
      return why
        ? [
            {
              name: `Hand-out · ${matterOf(a.id)?.name ?? "no matter"}`,
              relation: why,
            },
          ]
        : [];
    }),
  ];
}

/** The nightly's hand-out and token rows since `since`: the desk read once, over the matter book `book` read already. */
function readDeskRows(
  since: string,
  book: readonly MatterView[],
  all: ReturnType<typeof decisionsNow>
) {
  const read = readDesk((db) => {
    const turns = tokensSince(db, since);
    const handed = handedOutAgentsSince(db, since);
    const agents = new Set([
      ...turns.map((t) => t.agent_id),
      ...handed.map((a) => a.id),
    ]);
    return {
      anchors: [...agents].map(
        (id) =>
          [id, anchorsOf(db, currentAssignmentOf(db, id)?.id ?? "")] as const
      ),
      handed,
      turns,
    };
  }, null);
  if (
    read.state !== "ok" ||
    !read.value ||
    read.value.turns.length + read.value.handed.length === 0
  ) {
    return [];
  }
  const anchors = new Map(read.value.anchors);
  const find = matterFinderOf(book);
  const matterOf = (id: string) => find(anchors.get(id) ?? []);
  const decisions = all.flatMap((d) =>
    d.agent ? [{ agent: d.agent, state: d.state }] : []
  );
  const cards = {
    answered: new Set(
      decisions.filter((d) => d.state === "answered").map((d) => d.agent)
    ),
    everAsked: new Set(decisions.map((d) => d.agent)),
  };
  return [
    ...handOutRowsOf(read.value.handed, cards, matterOf),
    ...tokenRowsOf(read.value.turns, matterOf),
  ];
}
