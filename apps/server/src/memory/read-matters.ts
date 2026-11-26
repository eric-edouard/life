import type { MatterIconKey } from "../records/matter-icon";
import { isUnderway, type Project } from "../records/truth";
import { communicationStylesOf } from "./communication-styles";
import { decisionsNow } from "./decisions";
import {
  type AgentHold,
  agentForOf,
  isHeldOf,
  type StandingAgent,
} from "./held-matters";
import { instructionsFor } from "./instructions";
import { matterEndOf } from "./matter-end";
import { iconNow, readLifeIcons } from "./matter-icons";
import {
  directionDueOf,
  isRunning,
  type MatterView,
  matterFinderOf,
  matterOfSteps,
  matterPeopleOf,
  nextStepNow,
  offerEndOf,
} from "./matter-read";
import { readMatterBook, readMatterBookAndRecords } from "./matters";
import { readDismissedMatterPins } from "./memory-files";
import type { Party } from "./party";
import { rankContextOf, rankedMattersOf } from "./read-open-items";
import { goalsOf } from "./read-truth";
import {
  readMatterSituationNow,
  readProjectSituationNow,
  situationBlock,
} from "./situation-parts";
import { nameKey } from "./units";
import { meant, type People, readPeople } from "./who";
import { dayNow } from "./zones";

// The connector's reads of matters (`read_matters`, `read_matter`): the matters as `matterOf` reads them now, as data
// (his phone app and the models read the same). Reads only.

/** The id of the project or area `query` is, by id or name; undefined when it is neither. */
export const namedIdOf = (
  list: { id: string; name: string }[],
  query: string
) =>
  (
    list.find((x) => x.id === query) ??
    list.find((x) => nameKey(x.name) === nameKey(query))
  )?.id;

type Role = "owedTo" | "waitingOn" | "with";
const ROLES: readonly Role[] = ["owedTo", "waitingOn", "with"];

/**
 * A matter as the readers give it (`read_matters`, `read_matter`; data, the same for his app and the models): where it
 * stands, its goal (`by`: Life's draft or his word) and next step as they read now, its people by role, areas and
 * projects (by name: the filters `read_matters` takes), and the instant of its last step. A field with nothing in it is left out: a list of matters stays small for a model.
 */
export interface MatterRow {
  areas?: string[];
  /** The earliest date among its open steps (a day); left out when none has one. */
  dueOn?: string;
  /** When it ended, closed only (`matterEndOf`). */
  endedAt?: string;
  goal?: { by: "life" | "owner"; text: string };
  /** Its icon (`iconNow`): his pick, else Life's; left out with neither. */
  icon?: { by: "life" | "owner"; key: MatterIconKey };
  id: string;
  /** Marked important by his word (`MatterView.important`); left out when not. */
  important?: true;
  lastStepAt?: string;
  name: string;
  newestOpenStep?: { day: string; text: string };
  nextStep?: Pick<
    NonNullable<ReturnType<typeof nextStepNow>>,
    "by" | "kind" | "text" | "waitsOn"
  >;
  /** The instant of its first step. */
  openedAt?: string;
  /** How it ended, closed only (`matterEndOf`). */
  outcome?: NonNullable<ReturnType<typeof matterEndOf>>["outcome"];
  /** The people by role, as parties (`partyOf`). */
  people?: Partial<Record<Role, Party[]>>;
  /** The project it shows under (`projectOf`), its status as stored (the app shows active and waiting as underway). */
  project?: MatterProject;
  projects?: string[];
  status: MatterView["status"];
}

/** A matter's project as the readers give it: its id, name and status as stored in his directory. */
type MatterProject = Pick<Project, "id" | "name" | "status">;

/** The decisions he has not answered yet, for `nextStepNow`. */
export const openDecisions = () =>
  decisionsNow().filter((d) => d.state === "open");

/** `list`, or nothing when it is empty. */
const some = <T>(list: T[]) => (list.length > 0 ? list : undefined);

/** An area's or a project's name by its id, from his directory (the id when it names none). */
const nameIn = (list: { id: string; name: string }[], id: string) =>
  list.find((x) => x.id === id)?.name ?? id;

function rowOf(
  v: MatterView,
  { partyOf, truth }: Pick<People, "partyOf" | "truth">,
  decisions: ReturnType<typeof openDecisions>
): MatterRow {
  const project = projectOf(truth)(v);
  const next = nextStepNow(v, decisions);
  const people = Object.fromEntries(
    ROLES.flatMap((role) =>
      v[role].length > 0 ? [[role, v[role].map(partyOf)]] : []
    )
  );
  const end = matterEndOf(v);
  return {
    areas: some(v.areas.map((id) => nameIn(truth.areas, id))),
    dueOn: v.openSteps
      .flatMap((s) => (s.when ? [s.when] : []))
      .toSorted()
      .at(0),
    endedAt: end?.at,
    goal: v.goal && { by: v.goal.by, text: v.goal.text },
    icon: iconNow(v, readLifeIcons()),
    id: v.id,
    important: v.important || undefined,
    lastStepAt: v.steps.at(-1)?.at,
    name: v.name,
    newestOpenStep: v.newestOpenStep && {
      day: v.newestOpenStep.day,
      text: v.newestOpenStep.text,
    },
    nextStep: next && {
      by: next.by,
      kind: next.kind,
      text: next.text,
      waitsOn: next.waitsOn,
    },
    openedAt: v.steps.at(0)?.at,
    outcome: end?.outcome,
    people: Object.keys(people).length > 0 ? people : undefined,
    project: project && {
      id: project.id,
      name: project.name,
      status: project.status,
    },
    projects: some(v.projects.map((id) => nameIn(truth.projects, id))),
    status: v.status,
  };
}

/**
 * Whether a matter needs him: its next step is his decision or something only he does (`wait_decision`, `wait_owner`; a
 * stuck matter is stuck whatever its next step says), a check about it blocks him (`blockingChecks`), or it holds his
 * step (`isYourMove`: its your move card is open). The one rule,
 * for the row's flag dot and the Needs you filter on his phone, and for the night's count. Pure.
 */
export const needsYouOf = (
  m: { nextStep?: { kind: string }; status: string },
  blockingChecks: number,
  isYourMove = false
) =>
  (m.status !== "stuck" &&
    (m.nextStep?.kind === "wait_decision" ||
      m.nextStep?.kind === "wait_owner")) ||
  blockingChecks > 0 ||
  isYourMove;

/** A matter's steps' ids: what an agent working on it is anchored on. */
const refsOf = (v: MatterView) => v.steps.map((s) => s.ref);

/**
 * Whether a matter is in a scope: of an area and of a project when given, or in no project (`noProject`: the project it
 * shows under, `projectOf`, is none). The one rule of the matters list.
 */
export const isInScope = (
  truth: Pick<People["truth"], "projects">,
  s: { area?: string; noProject?: boolean; project?: string }
) => {
  const of = projectOf(truth);
  return (v: Pick<MatterView, "areas" | "projects">) =>
    (!s.area || v.areas.includes(s.area)) &&
    (!s.project || v.projects.includes(s.project)) &&
    (!s.noProject || of(v) === undefined);
};

/** Which matters a read lists: running (open and not dormant, or important: `isRunning`), open (the quiet ones too), or closed. */
export const MATTER_STATES = ["running", "open", "closed"] as const;
type MatterState = (typeof MATTER_STATES)[number];
const IS_IN_STATE: Record<MatterState, (v: MatterView) => boolean> = {
  closed: (v) => !v.open,
  open: (v) => v.open,
  running: isRunning,
};
/** A page of closed matters: this many, newest ended first. */
export const CLOSED_PAGE = 50;

/** A closed matter's place in the pages: its end's instant, then its id (ties keep their order across a page's edge). */
const closedKeyOf = (at: string | number, id = "") =>
  `${new Date(at).toISOString()}|${id}`;

/** A matter of a parked or done project, or a quiet one, ranks after every other: a stable partition, quiet before parked. */
const sunkOf = (isParked: (v: MatterView) => boolean) => (v: MatterView) =>
  (isParked(v) ? 2 : 0) + (isRunning(v) ? 0 : 1);

/**
 * The matters of the book `read` gives in a `state` (running when not given; `MATTER_STATES`), of one `person`, `project`
 * or `area` when given, or of an area in no project. Open ones ranked as `read_day`'s Due (`rankedMattersOf`), quiet and
 * parked ones last; closed ones newest ended first (`matterEndOf`), a page of `CLOSED_PAGE` before `before` (the last
 * page's `nextBefore`, or an instant), with `nextBefore` when more are left. With what rows are read from and what `read` gave. Throws when a name goes by no one known.
 */
export async function rankedMatters<R extends { book: MatterView[] }>(
  q: {
    area?: string;
    before?: string;
    noProject?: boolean;
    person?: string;
    project?: string;
    state?: MatterState;
  },
  read: (people: People, today: string) => Promise<R>,
  given?: People
) {
  const people = given ?? (await readPeople());
  const { truth } = people;
  const known = q.person ? meant(q.person, people).known : undefined;
  const area = q.area ? namedIdOf(truth.areas, q.area) : undefined;
  const project = q.project ? namedIdOf(truth.projects, q.project) : undefined;
  const missing = [
    q.person && !known ? "person" : "",
    q.area && !area ? "area" : "",
    q.project && !project ? "project" : "",
  ].find(Boolean);
  if (missing) {
    throw new Error(`No ${missing} goes by that name.`);
  }
  const ref = known && `person:${known}`;
  const today = dayNow();
  const r = await read(people, today);
  const isIn = isInScope(truth, { area, noProject: q.noProject, project });
  const isInState = IS_IN_STATE[q.state ?? "running"];
  const picked = r.book.filter(
    (v) =>
      isInState(v) &&
      (!ref || ROLES.some((role) => v[role].includes(ref))) &&
      isIn(v)
  );
  const base = { ...r, decisions: openDecisions(), people, project };
  if (q.state === "closed") {
    const [at, id] = (q.before ?? "").split("|");
    const before = at ? closedKeyOf(at, id) : undefined;
    const ended = picked
      .map((v) => ({ key: closedKeyOf(matterEndOf(v)?.at ?? 0, v.id), v }))
      .filter((e) => !before || e.key < before)
      .toSorted((a, b) => b.key.localeCompare(a.key));
    const page = ended.slice(0, CLOSED_PAGE);
    return {
      ...base,
      nextBefore: ended.length > page.length ? page.at(-1)?.key : undefined,
      ranked: page.map((e) => e.v),
    };
  }
  const sunk = sunkOf(isParkedMatterOf(truth));
  return {
    ...base,
    nextBefore: undefined,
    ranked: rankedMattersOf(
      picked,
      people.nameOf,
      today,
      rankContextOf(people)
    ).toSorted((a, b) => sunk(a) - sunk(b)),
  };
}

/**
 * The matters in a state (`rankedMatters`: running when not given), of one `person`, `project` or `area` when given: each
 * as `MatterRow`, with `agentOf`'s registered agent on it (from host: the one an open assignment anchors on the matter). Throws when a person, project or area named goes by no name known.
 * Of one project, its page's head too (`project`): its name, status as stored and the first of his goals naming it; a
 * matter is parked by the project its row shows under (`projectOf`), not by this one.
 */
export async function openMatters(
  q: Parameters<typeof rankedMatters>[0],
  agentOf: (steps: string[]) => string | undefined = () => undefined
) {
  const { book, decisions, nextBefore, people, project, ranked } =
    await rankedMatters(q, async (p, t) => ({
      book: await readMatterBook(p, t),
    }));
  const { truth } = people;
  const head = truth.projects.find((x) => x.id === project);
  return {
    ...(head && {
      project: {
        goal: goalsOf(truth.me.goals).find((g) => g.projects.includes(head.id))
          ?.text,
        id: head.id,
        name: head.name,
        situation: readProjectSituationNow(
          head.id,
          projectStepRefsOf(truth, book, head.id)
        ),
        status: head.status,
      },
    }),
    matters: ranked.map((v) => ({
      ...rowOf(v, people, decisions),
      agent: agentOf(refsOf(v)),
    })),
    ...(nextBefore && { nextBefore }),
  };
}

/**
 * Whether a matter is one of his (his word of 20 Nov 2026): it involves someone he knows (`isKnownToHim`: his directory,
 * a person or an organization, his Contacts, or one Life inferred that his word named; never an `unknown:` ref) or holds an open step he said himself. One
 * made only of an unknown sender's words, or of Life's guesses alone, waits for his own Start.
 */
export const isOneOfHis = (
  v: Pick<MatterView, "hasOwnOpenStep" | "owedTo" | "waitingOn" | "with">,
  people: Pick<People, "isKnownToHim">
) => v.hasOwnOpenStep || knownPeopleOf(v, people).length > 0;

/** The steps of the matters that show under project `id` (`projectOf`), running or not: what a project situation part may still cite. */
export const projectStepRefsOf = (
  truth: Pick<People["truth"], "projects">,
  book: readonly Pick<MatterView, "openSteps" | "projects" | "steps">[],
  id: string
) =>
  new Set(
    book
      .filter((v) => projectOf(truth)(v)?.id === id)
      .flatMap((v) => [...v.steps, ...v.openSteps].map((s) => s.ref))
  );

/** What an agent's packet says of where each project in `projectIds` stands, in order (`readProjectSituationNow`): empty for one with no situation. */
export function readProjectSituationsNow(
  truth: Pick<People["truth"], "projects">,
  projectIds: readonly string[],
  book: readonly MatterView[]
) {
  return projectIds.map((id) => {
    const parts = readProjectSituationNow(
      id,
      projectStepRefsOf(truth, book, id)
    );
    return situationBlock("Where it stands (read as data)", parts)
      .join("\n")
      .trim();
  });
}

/** A matter's people he knows (`isKnownToHim`). */
const knownPeopleOf = (
  v: Pick<MatterView, "owedTo" | "waitingOn" | "with">,
  { isKnownToHim }: Pick<People, "isKnownToHim">
) =>
  matterPeopleOf(v).filter((r) => r.startsWith("person:") && isKnownToHim(r));

/** The project a matter shows under: of its projects in his directory, the first underway (`isUnderway`), else the first; none when his directory holds none of them. */
export const projectOf =
  ({ projects }: Pick<People["truth"], "projects">) =>
  (v: Pick<MatterView, "projects">) => {
    const known = v.projects.flatMap(
      (id) => projects.find((x) => x.id === id) ?? []
    );
    return known.find(isUnderway) ?? known[0];
  };

/** Whether a matter is of a parked or done project: the project it shows under (`projectOf`) is not underway; one with no project in his directory, or one project underway, is not. */
export const isParkedMatterOf = (truth: Pick<People["truth"], "projects">) => {
  const of = projectOf(truth);
  return (v: Pick<MatterView, "projects">) => {
    const p = of(v);
    return p !== undefined && !isUnderway(p);
  };
};

const ids = (list: readonly { id: string }[]) => new Set(list.map((v) => v.id));

/** The ids of the matters of `book` he dismissed as new matter checks, each found by the steps it was pinned to (`pins`). Over the whole book, so the hand-out, the new matter check and the report agree. */
export const dismissedIdsOf = (
  book: readonly { id: string; steps: readonly { ref: string }[] }[],
  pins: readonly (readonly string[])[]
) => {
  const find = matterFinderOf(book);
  return new Set(pins.flatMap((p) => find(p)?.id ?? []));
};

/** Why a running matter is not handed out, the first gate it fails, in this order (`handOutGateOf`). */
export type HandOutGate =
  | "not_do"
  | "project_parked"
  | "hands_off"
  | "direction_due"
  | "dismissed"
  | "held"
  | "not_his"
  | "no_agent";

/** A matter as the hand-out reads it: what the gates read, its projects and its steps (id and instant). */
export type HandOutMatter = Pick<MatterView, "id" | "nextStep" | "projects"> & {
  steps: readonly { at: string; ref: string }[];
};

/** What `handOutGateOf` reads besides the matter, all as data (by the matter's id, or `isHeld`: the hold that holds it, `isHeldOf`; `agentFor`: the agent that takes it, `agentForMatterOf`, absent for the new matter check, which waits on none). */
export interface HandOutFacts {
  agentFor?: (v: HandOutMatter) => string | undefined;
  decisions: Parameters<typeof nextStepNow>[1];
  dismissed: ReadonlySet<string>;
  isDue: (id: string) => boolean;
  /** Whether his `hands-off` instruction holds on the matter's project: Life helps there only when asked (absent: none). */
  isHandsOff?: (id: string) => boolean;
  isHeld: (v: HandOutMatter) => AgentHold | undefined;
  isHis: (id: string) => boolean;
  isParked: (id: string) => boolean;
}

/**
 * The first gate a running matter fails for the hand-out, or null when it passes every one: its next step is not `do`
 * as it reads now (`nextStepNow`), its project is parked or hands off (his `hands-off` instruction), its direction is due (news may have overtaken it), he
 * dismissed it, an agent holds it, it is not one of his (`isOneOfHis`, so a stranger's matter reads "not his"), no
 * agent takes it (`agentFor`: no agent of its project and no Personal agent). The one rule of the hand-out, the new
 * matter check and the report's agent coverage. Pure.
 */
export function handOutGateOf(
  v: HandOutMatter,
  f: HandOutFacts
): HandOutGate | null {
  if (nextStepNow(v, f.decisions)?.kind !== "do") {
    return "not_do";
  }
  if (f.isParked(v.id)) {
    return "project_parked";
  }
  if (f.isHandsOff?.(v.id)) {
    return "hands_off";
  }
  if (f.isDue(v.id)) {
    return "direction_due";
  }
  if (f.dismissed.has(v.id)) {
    return "dismissed";
  }
  if (f.isHeld(v)) {
    return "held";
  }
  if (!f.isHis(v.id)) {
    return "not_his";
  }
  return !f.agentFor || f.agentFor(v) ? null : "no_agent";
}

/**
 * Which agent takes matter `v`, by id, among `standing` (`agentForOf`): a project's agent only when the project it shows
 * under (`projectOf`) has a repo, since code work needs that folder and its rules; else the Personal agent, which reads
 * the project's context all the same (his yes of 25 Nov 2026, question 6). Pure.
 */
export const agentForMatterOf = (
  standing: readonly StandingAgent[],
  truth: Pick<People["truth"], "projects">
) => {
  const take = agentForOf(standing);
  const shown = projectOf(truth);
  return (v: Pick<MatterView, "projects">) => {
    const p = shown(v);
    return take(p?.repos.length ? p.id : undefined)?.id;
  };
};

/**
 * The running matters in his ranking (parked ones last), with the facts `handOutGateOf` needs but the hold (the desk's):
 * what the desk may hand to an agent is the first with no gate. `read` gives the book and records, so a report that
 * read them already passes them.
 */
export async function readHandOutMatters(
  read = readMatterBookAndRecords,
  /** The people, when the caller read them already. */
  given?: People
) {
  const { book, decisions, people, ranked, records } = await rankedMatters(
    {},
    read,
    given
  );
  const isParked = isParkedMatterOf(people.truth);
  const his = ids(ranked.filter((v) => isOneOfHis(v, people)));
  const parked = ids(ranked.filter(isParked));
  const shown = projectOf(people.truth);
  const handsOff = new Set(
    instructionsFor({ projects: people.truth.projects.map((p) => p.id) })
      .filter((i) => i.effect === "hands-off")
      .map((i) => i.scope)
  );
  const offIds = ids(
    ranked.filter(
      (v) => handsOff.has("all") || handsOff.has(`project:${shown(v)?.id}`)
    )
  );
  return {
    facts: {
      decisions,
      dismissed: dismissedIdsOf(book, readDismissedMatterPins()),
      isDue: directionDueOf(book, records, dayNow()),
      isHandsOff: (id: string) => offIds.has(id),
      isHis: (id: string) => his.has(id),
      isParked: (id: string) => parked.has(id),
    },
    matters: ranked,
  };
}

/** The ids of the projects of the matter `refs` find (`matterOfSteps`, `prefer` its tie-breaker; from `book` when the caller read it); none when no matter holds them. The row names them, so a reader that needs the ids (the packet) asks here. */
export const readMatterProjectIds = async (
  refs: readonly string[],
  prefer?: string,
  book?: readonly MatterView[]
) =>
  matterOfSteps(
    book ?? (await readMatterBook(await readPeople(), dayNow())),
    refs,
    prefer
  )?.projects ?? [];

/**
 * What a packet reads of the matters, from one book: the matter `refs` find (`oneMatter`, `prefer` the matter it was given; none for an agent on its
 * project), the ids of its projects with the agent's own `project`, and each one's situation text (`readProjectSituationsNow`), in order; and the book.
 */
export async function readPacketMatter(
  refs: readonly string[],
  project: string | null,
  isOnProject: boolean,
  truth: Pick<People["truth"], "projects">,
  prefer?: string
) {
  const book = await readMatterBook(await readPeople(), dayNow());
  const projectIds = [
    ...new Set([
      ...(project ? [project] : []),
      ...(isOnProject ? [] : await readMatterProjectIds(refs, prefer, book)),
    ]),
  ];
  return {
    book,
    ids: projectIds,
    matter: isOnProject ? undefined : await oneMatter(refs, { book, prefer }),
    situations: readProjectSituationsNow(truth, projectIds, book),
  };
}

/**
 * One matter, found by `refs` (its id, or its steps' ids: the matter holding the most of them, `matterOfSteps`, so an
 * agent anchored on records finds its matter again after a re-group; `prefer`, the matter it was given, settles a tie): its `MatterRow`, its steps in time order (each
 * with its day, words, quote, who it was with as a party and `ending`: none while open), then `agentsOf`'s agents on it now and before (from host), then the communication styles of its people he knows (`communicationStylesOf`: a draft to them follows his).
 * Undefined when no matter holds them.
 */
export async function oneMatter<A, S = undefined>(
  refs: readonly string[],
  {
    agentsOf = () => [],
    book,
    prefer,
    spendingOf,
  }: {
    agentsOf?: (steps: string[], people: People) => A[];
    /** The book when the caller read it already. */
    book?: readonly MatterView[];
    prefer?: string;
    // What the matter spent, by the book's own finder (host's desk reads; memory reads no desk).
    spendingOf?: (
      find: ReturnType<typeof matterFinderOf<MatterView>>,
      id: string,
      steps: string[]
    ) => S;
  } = {}
) {
  const people = await readPeople();
  const find = matterFinderOf(book ?? (await readMatterBook(people, dayNow())));
  const v = find(refs, prefer);
  if (!v) {
    return;
  }
  const row = rowOf(v, people, openDecisions());
  // The next step's context (his or Life's), on one matter's read only (never in the list); none on a wait for his decision.
  const context =
    row.nextStep?.kind === "wait_decision" ? undefined : v.nextStep?.context;
  return {
    ...row,
    ...(context && row.nextStep
      ? { nextStep: { ...row.nextStep, context } }
      : {}),
    agents: agentsOf(refsOf(v), people),
    communicationStyles: communicationStylesOf(
      knownPeopleOf(v, people),
      people.nameOf
    ),
    situation: readMatterSituationNow(v.id),
    spending: spendingOf?.(find, v.id, [v.id, ...refsOf(v)]),
    steps: v.steps.map((s) =>
      s.with ? { ...s, with: people.partyOf(s.with) } : s
    ),
  };
}

/**
 * Each running matter he has not answered "Start an agent on this?" for, by id, with its next step and the offer's last
 * day: one that began in the last `NEW_MATTER_DAYS` (its first step's day), with an open step, not stuck, a goal and a
 * next step to hand over (the hand-out's gates, `handOutGateOf`), held by no agent (`isHeldOf`), not dismissed, and,
 * while the hand-out is on, not one of his own (`isOneOfHis`); none while the desk is off or unreadable. Pure.
 */
export function newMatterOffersOf(c: {
  decisions: HandOutFacts["decisions"];
  dismissed: readonly (readonly string[])[];
  heldByAgents: readonly AgentHold[] | null;
  isDirectionDue: (matter: string) => boolean;
  isForHandOut: (matter: string) => boolean;
  isParked: (matter: string) => boolean;
  matters: readonly (HandOutMatter &
    Pick<MatterView, "goal" | "lone" | "newestOpenStep" | "open" | "status"> & {
      important?: boolean;
      steps: readonly { at: string; day: string; ref: string }[];
    })[];
  today: string;
}) {
  const facts = {
    decisions: c.decisions,
    dismissed: dismissedIdsOf(c.matters, c.dismissed),
    isDue: c.isDirectionDue,
    isHeld: isHeldOf(c.heldByAgents ?? []),
    isHis: () => true,
    isParked: c.isParked,
  };
  return new Map(
    c.matters.flatMap((v) => {
      const next = nextStepNow(v, c.decisions);
      const lastDay = offerEndOf(v);
      return c.heldByAgents &&
        lastDay &&
        c.today <= lastDay &&
        v.newestOpenStep &&
        v.status !== "stuck" &&
        v.goal &&
        next &&
        !v.lone &&
        isRunning(v) &&
        handOutGateOf(v, facts) === null &&
        !c.isForHandOut(v.id)
        ? [[v.id, { lastDay, next }] as const]
        : [];
    })
  );
}
