import { QUOTE_MAX } from "./index-rows";
import { isRunning, type MatterStepNow, type MatterView } from "./matter-read";
import { readMatterBook } from "./matters";
import { clip } from "./units";
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
  `- ${s.day} ${s.kind} ${s.ref}: ${s.text}${s.when ? ` (for ${s.when})` : ""} "${clip(s.quote.replace(/\s+/g, " "), QUOTE_MAX)}"`;

/**
 * The running matters (open, not dormant), the newest step first, of one `person`, `project` or `area` when given: each with its matter
 * status, who it is owed to, who is waited on and what is next.
 */
export async function openMatters(q: {
  area?: string;
  person?: string;
  project?: string;
}) {
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
  const open = (await readMatterBook(people, dayNow())).filter(
    (v) =>
      isRunning(v) &&
      (!ref || WHO.some(([, of]) => of(v).includes(ref))) &&
      (!area || v.areas.includes(area)) &&
      (!project || v.projects.includes(project))
  );
  return open.length === 0
    ? "No running matter."
    : open
        .map((v) => {
          const who = WHO.slice(0, 2).flatMap(([label, of]) =>
            of(v).length > 0
              ? [`${label} ${of(v).map(people.nameOf).join(", ")}`]
              : []
          );
          return `- ${v.id} ${v.name} [${v.status}]${who.map((w) => `; ${w}`).join("")}${v.next ? `; next: ${v.next.text} (${v.next.day})` : ""}`;
        })
        .join("\n");
}

/** One matter, by id: where it stands, its people by role, projects and areas, and its steps in time order, each with its day and words. */
export async function oneMatter(id: string) {
  const people = await readPeople();
  const v = (await readMatterBook(people, dayNow())).find((m) => m.id === id);
  if (!v) {
    return `No matter ${id}.`;
  }
  return [
    `${v.id} ${v.name} [${v.status}]${v.open ? "" : " (done)"}`,
    ...WHO.flatMap(([label, of]) =>
      of(v).length > 0
        ? [`${label}: ${of(v).map(people.nameOf).join(", ")}`]
        : []
    ),
    ...(v.projects.length > 0 ? [`Projects: ${v.projects.join(", ")}`] : []),
    ...(v.areas.length > 0 ? [`Areas: ${v.areas.join(", ")}`] : []),
    ...(v.next ? [`Next: ${v.next.text}`] : []),
    "Steps, oldest first:",
    ...v.steps.map(stepLine),
  ].join("\n");
}
