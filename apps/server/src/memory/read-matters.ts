import { decisionsNow } from "./decisions";
import {
  isRunning,
  type MatterView,
  matterOfSteps,
  nextStepNow,
} from "./matter-read";
import { readMatterBook } from "./matters";
import { rankContextOf, rankedMattersOf } from "./read-open-items";
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
  lastStepAt?: string;
  name: string;
  newestOpenStep?: { day: string; text: string };
  nextStep?: Pick<
    NonNullable<ReturnType<typeof nextStepNow>>,
    "by" | "kind" | "text" | "waitsOn"
  >;
  /** The people by role, by their names as read now (`read_person_page` takes a name). */
  people?: Partial<Record<Role, string[]>>;
  projects?: string[];
  status: MatterView["status"];
}

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
    projects: some(v.projects.map((id) => nameIn(truth.projects, id))),
    status: v.status,
  };
}

/** A matter's steps' ids: what an agent working on it is anchored on. */
const refsOf = (v: MatterView) => v.steps.map((s) => s.ref);

/**
 * The running matters (open, not dormant), ranked as `read_day`'s Due (`rankedMattersOf`, those with no open step last), of one `person`, `project` or `area` when given: each
 * as `MatterRow`, with `agentOf`'s registered agent on it (from host: the one anchored on the matter, else the one holding one of its projects). Throws when a person, project or area named goes by no name known.
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
  const people = await readPeople();
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
  const running = (await readMatterBook(people, today)).filter(
    (v) =>
      isRunning(v) &&
      (!ref || ROLES.some((role) => v[role].includes(ref))) &&
      (!area || v.areas.includes(area)) &&
      (!project || v.projects.includes(project))
  );
  const decisions = openDecisions();
  return {
    matters: rankedMattersOf(
      running,
      people.nameOf,
      today,
      rankContextOf(people)
    ).map((v) => ({
      ...rowOf(v, people, decisions),
      agent: agentOf(refsOf(v), v.projects),
    })),
  };
}

/**
 * One matter, found by `refs` (its id, or its steps' ids: the matter holding the most of them, `matterOfSteps`, so an
 * agent anchored on records finds its matter again after a re-group): its `MatterRow`, its steps in time order (each
 * with its day, words, quote, who it was with by name and `ending`: none while open), then `agentsOf`'s agents on it now and before, then its projects' workers (from host).
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
      steps: v.steps.map((s) =>
        s.with ? { ...s, with: people.nameOf(s.with) } : s
      ),
    }
  );
}
