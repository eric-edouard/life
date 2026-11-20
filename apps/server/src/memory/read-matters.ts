import { isUnderway, type Project } from "../records/truth";
import { communicationStylesOf } from "./communication-styles";
import { decisionsNow } from "./decisions";
import type { AgentHold } from "./held-matters";
import {
  directionDueOf,
  isRunning,
  type MatterView,
  matterFinderOf,
  matterOfSteps,
  matterPeopleOf,
  nextStepNow,
} from "./matter-read";
import { readMatterBook, readMatterBookAndRecords } from "./matters";
import { readDismissedMatterPins } from "./memory-files";
import { rankContextOf, rankedMattersOf } from "./read-open-items";
import { goalsOf } from "./read-truth";
import { meant, type People, readPeople } from "./who";
import { dayNow } from "./zones";

// The connector's reads of matters (`read_matters`, `read_matter`): the matters as `matterOf` reads them now, as data
// (his phone app and the models read the same). Reads only.

/** The id of the project or area `query` is, by id or name; undefined when it is neither. */
const idOf = (list: { id: string; name: string }[], query: string) =>
  list.find(
    (x) => x.id === query || x.name.toLowerCase() === query.toLowerCase()
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
  goal?: { by: "life" | "owner"; text: string };
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
  /** The people by role, by their names as read now (`read_person_page` takes a name). */
  people?: Partial<Record<Role, string[]>>;
  /** The project it shows under (`projectOf`), its status as stored (the app shows active and waiting as underway). */
  project?: MatterProject;
  projects?: string[];
  status: MatterView["status"];
}

/** A matter's project as the readers give it: its id, name and status as stored in his directory. */
type MatterProject = Pick<Project, "id" | "name" | "status">;

/** The decisions he has not answered yet, for `nextStepNow`. */
const openDecisions = () => decisionsNow().filter((d) => d.state === "open");

/** `list`, or nothing when it is empty. */
const some = <T>(list: T[]) => (list.length > 0 ? list : undefined);

/** An area's or a project's name by its id, from his directory (the id when it names none). */
const nameIn = (list: { id: string; name: string }[], id: string) =>
  list.find((x) => x.id === id)?.name ?? id;

function rowOf(
  v: MatterView,
  { nameOf, truth }: Pick<People, "nameOf" | "truth">,
  decisions: ReturnType<typeof openDecisions>
): MatterRow {
  const project = projectOf(truth)(v);
  const next = nextStepNow(v, decisions);
  const people = Object.fromEntries(
    ROLES.flatMap((role) =>
      v[role].length > 0 ? [[role, v[role].map(nameOf)]] : []
    )
  );
  return {
    areas: some(v.areas.map((id) => nameIn(truth.areas, id))),
    goal: v.goal && { by: v.goal.by, text: v.goal.text },
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
 * stuck matter is stuck whatever its next step says), or a check about it blocks him (`blockingChecks`). The one rule,
 * for the row's flag dot and the Needs you filter on his phone, and for the night's count. Pure.
 */
export const needsYouOf = (
  m: { nextStep?: { kind: string }; status: string },
  blockingChecks: number
) =>
  (m.status !== "stuck" &&
    (m.nextStep?.kind === "wait_decision" ||
      m.nextStep?.kind === "wait_owner")) ||
  blockingChecks > 0;

/** A matter's steps' ids: what an agent working on it is anchored on. */
const refsOf = (v: MatterView) => v.steps.map((s) => s.ref);

/** The running matters (open, not dormant) of the book `read` gives, ranked as `read_day`'s Due (`rankedMattersOf`), of one `person`, `project` or `area` when given; with what rows are read from and what `read` gave. Throws when a name goes by no one known. */
async function rankedRunning<R extends { book: MatterView[] }>(
  q: {
    area?: string;
    person?: string;
    project?: string;
  },
  read: (people: People, today: string) => Promise<R>,
  given?: People
) {
  const people = given ?? (await readPeople());
  const { truth } = people;
  const known = q.person ? meant(q.person, people).known : undefined;
  const area = q.area ? idOf(truth.areas, q.area) : undefined;
  const project = q.project ? idOf(truth.projects, q.project) : undefined;
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
  const running = r.book.filter(
    (v) =>
      isRunning(v) &&
      (!ref || ROLES.some((role) => v[role].includes(ref))) &&
      (!area || v.areas.includes(area)) &&
      (!project || v.projects.includes(project))
  );
  const ranked = rankedMattersOf(
    running,
    people.nameOf,
    today,
    rankContextOf(people)
  );
  const isParked = isParkedMatterOf(truth);
  return {
    ...r,
    decisions: openDecisions(),
    people,
    project,
    // A matter of a parked or done project ranks after every other: a stable partition.
    ranked: [
      ...ranked.filter((v) => !isParked(v)),
      ...ranked.filter((v) => isParked(v)),
    ],
  };
}

/**
 * The running matters, ranked as `read_day`'s Due (those with no open step last), of one `person`, `project` or `area` when given: each
 * as `MatterRow`, with `agentOf`'s registered agent on it (from host: the one anchored on the matter, else the one holding one of its projects). Throws when a person, project or area named goes by no name known.
 * Of one project, its page's head too (`project`): its name, status as stored, the first of his goals naming it, and, when it is not
 * underway, how many of its matters are parked (`parkedMatters`, `isParkedMatterOf`).
 */
export async function openMatters(
  q: {
    area?: string;
    person?: string;
    project?: string;
  },
  agentOf: (steps: string[], projects: string[]) => string | undefined = () =>
    undefined
) {
  const { decisions, people, project, ranked } = await rankedRunning(
    q,
    async (p, t) => ({
      book: await readMatterBook(p, t),
    })
  );
  const { truth } = people;
  const head = truth.projects.find((x) => x.id === project);
  const isParked = isParkedMatterOf(truth);
  return {
    ...(head && {
      project: {
        goal: goalsOf(truth.me.goals).find((g) => g.projects.includes(head.id))
          ?.text,
        id: head.id,
        name: head.name,
        parkedMatters: isUnderway(head)
          ? undefined
          : ranked.filter(isParked).length,
        status: head.status,
      },
    }),
    matters: ranked.map((v) => ({
      ...rowOf(v, people, decisions),
      agent: agentOf(refsOf(v), v.projects),
    })),
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
  | "direction_due"
  | "dismissed"
  | "held"
  | "not_his";

/** A matter as the hand-out reads it: what the gates read, its projects and its steps (id and instant). */
export type HandOutMatter = Pick<MatterView, "id" | "nextStep" | "projects"> & {
  steps: readonly { at: string; ref: string }[];
};

/** What `handOutGateOf` reads besides the matter, all as data (by the matter's id, or `isHeld`: the hold that holds it, `isHeldOf`). */
export interface HandOutFacts {
  decisions: Parameters<typeof nextStepNow>[1];
  dismissed: ReadonlySet<string>;
  isDue: (id: string) => boolean;
  isHeld: (v: HandOutMatter) => AgentHold | undefined;
  isHis: (id: string) => boolean;
  isParked: (id: string) => boolean;
}

/**
 * The first gate a running matter fails for the hand-out, or null when it passes every one: its next step is not `do`
 * as it reads now (`nextStepNow`), its project is parked, its direction is due (news may have overtaken it), he
 * dismissed it, an agent holds it, it is not one of his (`isOneOfHis`; last, so a stranger's matter reads "not his").
 * The one rule of the hand-out, the new matter check and the report's agent coverage. Pure.
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
  if (f.isDue(v.id)) {
    return "direction_due";
  }
  if (f.dismissed.has(v.id)) {
    return "dismissed";
  }
  if (f.isHeld(v)) {
    return "held";
  }
  return f.isHis(v.id) ? null : "not_his";
}

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
  const { book, decisions, people, ranked, records } = await rankedRunning(
    {},
    read,
    given
  );
  const isParked = isParkedMatterOf(people.truth);
  const his = ids(ranked.filter((v) => isOneOfHis(v, people)));
  const parked = ids(ranked.filter(isParked));
  return {
    facts: {
      decisions,
      dismissed: dismissedIdsOf(book, readDismissedMatterPins()),
      isDue: directionDueOf(book, records, dayNow()),
      isHis: (id: string) => his.has(id),
      isParked: (id: string) => parked.has(id),
    },
    matters: ranked,
  };
}

/** The ids of the projects of the matter `refs` find (`matterOfSteps`); none when no matter holds them. The row names them, so a reader that needs the ids (the packet) asks here. */
export const readMatterProjectIds = async (refs: readonly string[]) =>
  matterOfSteps(await readMatterBook(await readPeople(), dayNow()), refs)
    ?.projects ?? [];

/**
 * One matter, found by `refs` (its id, or its steps' ids: the matter holding the most of them, `matterOfSteps`, so an
 * agent anchored on records finds its matter again after a re-group): its `MatterRow`, its steps in time order (each
 * with its day, words, quote, who it was with by name and `ending`: none while open), then `agentsOf`'s agents on it now and before, then the registered agents active on its projects (from host), then the communication styles of its people he knows (`communicationStylesOf`: a draft to them follows his).
 * Undefined when no matter holds them.
 */
export async function oneMatter<A>(
  refs: readonly string[],
  agentsOf: (
    steps: string[],
    projects: string[],
    people: People
  ) => A[] = () => []
) {
  const people = await readPeople();
  const v = matterOfSteps(await readMatterBook(people, dayNow()), refs);
  return (
    v && {
      ...rowOf(v, people, openDecisions()),
      agents: agentsOf(refsOf(v), v.projects, people),
      communicationStyles: communicationStylesOf(
        knownPeopleOf(v, people),
        people.nameOf
      ),
      steps: v.steps.map((s) =>
        s.with ? { ...s, with: people.nameOf(s.with) } : s
      ),
    }
  );
}
