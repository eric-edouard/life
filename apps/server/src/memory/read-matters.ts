import { decisionsNow } from "./decisions";
import {
  isRunning,
  type MatterStepNow,
  type MatterView,
  matterOfSteps,
  nextStepNow,
} from "./matter-read";
import { readMatterBook } from "./matters";
import {
  endingWords,
  oneLine,
  rankContextOf,
  rankedMattersOf,
} from "./read-open-items";
import { meant, readPeople } from "./who";
import { dayNow } from "./zones";

// The connector's reads of matters (`read_matters`, `read_matter`): the matters as `matterOf` reads them now. Reads only.

/** The id of the project or area `query` is, by id or name; undefined when it is neither. */
const idOf = (list: { id: string; name: string }[], query: string) =>
  list.find(
    (x) => x.id === query || x.name.toLowerCase() === query.toLowerCase()
  )?.id;

const WHO = [
  ["owed to", (v: MatterView) => v.owedTo],
  ["waiting on", (v: MatterView) => v.waitingOn],
  ["with", (v: MatterView) => v.with],
  ["told", (v: MatterView) => v.told],
] as const;

const stepLine = (s: MatterStepNow) =>
  `- ${s.day} ${s.kind} ${s.ref}: ${s.text}${s.when ? ` (for ${s.when})` : ""}${endingWords(s)} "${oneLine(s.quote)}"`;

/** Life's mark on what it drafted; his own word bears none. */
const drafted = (by?: string) => (by === "life" ? " (Life's draft)" : "");

/** The decisions he has not answered yet, for `nextStepNow`. */
const openDecisions = () => decisionsNow().filter((d) => d.state === "open");

/** A matter's next step in words: its kind, what a wait waits on, the line. */
function nextStepWords(v: MatterView, open: ReturnType<typeof openDecisions>) {
  const n = nextStepNow(v, open);
  if (!n) {
    return;
  }
  const waits = n.waitsOn ? ` (${n.waitsOn})` : "";
  return `${n.kind}${waits}: ${n.text}${drafted(n.by)}`;
}

/** A matter's steps' ids: what an agent working on it is anchored on. */
const refsOf = (v: MatterView) => v.steps.map((s) => s.ref);

/**
 * The running matters (open, not dormant), ranked as `read_day`'s Due (`rankedMattersOf`, those with no open step last), of one `person`, `project` or `area` when given: each with its matter
 * status, its goal and next step, who it is owed to, who is waited on, and `markOf`'s mark (the agent on it, from host).
 */
export async function openMatters(
  q: {
    area?: string;
    person?: string;
    project?: string;
  },
  markOf: (steps: string[]) => string = () => ""
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
    return `No ${missing} goes by that name.`;
  }
  const ref = known && `person:${known}`;
  const today = dayNow();
  const running = (await readMatterBook(people, today)).filter(
    (v) =>
      isRunning(v) &&
      (!ref || WHO.some(([, of]) => of(v).includes(ref))) &&
      (!area || v.areas.includes(area)) &&
      (!project || v.projects.includes(project))
  );
  const open = rankedMattersOf(
    running,
    people.nameOf,
    today,
    rankContextOf(people)
  );
  const decisions = openDecisions();
  return open.length === 0
    ? "No running matter."
    : open
        .map((v) => {
          const next = nextStepWords(v, decisions);
          const who = WHO.slice(0, 2).flatMap(([label, of]) =>
            of(v).length > 0
              ? [`${label} ${of(v).map(people.nameOf).join(", ")}`]
              : []
          );
          const mark = markOf(refsOf(v));
          return `- ${v.id} ${v.name} [${v.status}]${v.goal ? `; goal: ${v.goal.text}${drafted(v.goal.by)}` : ""}${next ? `; next step: ${next}` : ""}${who.map((w) => `; ${w}`).join("")}${v.newestOpenStep ? `; newest open step: ${v.newestOpenStep.text} (${v.newestOpenStep.day})` : ""}${mark ? `; ${mark}` : ""}`;
        })
        .join("\n");
}

/**
 * One matter, found by `refs` (its id, or its steps' ids: the matter holding the most of them, `matterOfSteps`, so an
 * agent anchored on records finds its matter again after a re-group): where it stands, its goal and next step, its people by role, projects and
 * areas, and its steps in time order, each with its day and words; then `agentLinesOf`'s Agents part (who works on it
 * now and before, from host).
 */
export async function oneMatter(
  refs: readonly string[],
  agentLinesOf: (steps: string[]) => string[] = () => []
) {
  const people = await readPeople();
  const v = matterOfSteps(await readMatterBook(people, dayNow()), refs);
  if (!v) {
    return `No matter ${refs.join(", ")}.`;
  }
  const agents = agentLinesOf(refsOf(v));
  const next = nextStepWords(v, openDecisions());
  return [
    `${v.id} ${v.name} [${v.status}]`,
    ...(v.goal ? [`Goal: ${v.goal.text}${drafted(v.goal.by)}`] : []),
    ...(next ? [`Next step: ${next}`] : []),
    ...WHO.flatMap(([label, of]) =>
      of(v).length > 0
        ? [`${label}: ${of(v).map(people.nameOf).join(", ")}`]
        : []
    ),
    ...(v.projects.length > 0 ? [`Projects: ${v.projects.join(", ")}`] : []),
    ...(v.areas.length > 0 ? [`Areas: ${v.areas.join(", ")}`] : []),
    ...(v.newestOpenStep ? [`Newest open step: ${v.newestOpenStep.text}`] : []),
    "Steps, oldest first:",
    ...v.steps.map(stepLine),
    ...(agents.length > 0 ? ["Agents:", ...agents] : []),
  ].join("\n");
}
