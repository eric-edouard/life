import {
  latest,
  line,
  pageAndLatest,
  type UnitRow,
  unitLine,
  withIndex,
} from "./index-rows";
import { pagePath } from "./memory-files";
import { loadTruth, type Truth } from "./read-truth";
import { normalizeTopics } from "./tags";
import { nameKey } from "./units";

// `bun life memory area <id>` and the connector's `read_area_page`: an area's page and latest observations; and
// `bun life memory topics [tag]`: the top topics, or the units tagged so, by date.

/** The area an id or a name (any case or accents) means: an area's own, or a project's, with the project. */
export function areaFor(
  name: string,
  { areas, projects }: Pick<Truth, "areas" | "projects">
) {
  const is = (x: { id: string; name: string }) =>
    x.id === name ||
    (nameKey(name) !== "" && nameKey(x.name) === nameKey(name));
  const project = projects.find(is);
  return { id: project?.area ?? areas.find(is)?.id, project };
}

/**
 * `bun life memory area <id or name>`: an area's page and latest observations. A project's id or name reads its area,
 * after the project's line; a name that is neither lists the ids.
 */
export async function area(name: string) {
  const truth = await loadTruth();
  const { id, project } = areaFor(name, truth);
  if (!id) {
    return `No area or project "${name}". Areas: ${truth.areas.map((a) => a.id).join(", ")}. Projects: ${truth.projects.map((p) => p.id).join(", ")}.`;
  }
  const file = Bun.file(pagePath(`area:${id}`));
  const text = (await file.exists()) ? await file.text() : null;
  return withIndex((db) => [
    ...(project
      ? [
          `Project ${project.name} (${project.id}, ${project.status}), in area ${id}${project.deadlines.map((d) => `; ${d.date}: ${d.what}`).join("")}`,
          "",
        ]
      : []),
    ...pageAndLatest(db, text, latest(db, "where o.area = ?", id).map(line)),
  ]);
}

/**
 * `bun life memory topics [tag] [--person <id>]`: with no tag, the top topics and how many units carry each; with a tag,
 * the units tagged so, by date. `person` keeps the units that involve that person.
 */
export const topicsOf = (tag: string | undefined, who?: string) =>
  withIndex((db) => {
    const involving = who
      ? " and u.id in (select unit from unit_people where person = ?)"
      : "";
    const args = who ? [`person:${who}`] : [];
    if (!tag) {
      const rows = db
        .query<{ n: number; topic: string }, string[]>(
          `select t.topic, count(*) as n from unit_topics t join units u on u.id = t.unit
           where 1 = 1${involving} group by t.topic order by n desc, t.topic limit 40`
        )
        .all(...args);
      return rows.length > 0
        ? rows.map((r) => `- ${r.topic}: ${r.n}`)
        : ["(no topics yet: run episodes)"];
    }
    const wanted = normalizeTopics([tag])[0] ?? tag;
    const rows = db
      .query<UnitRow & { importance: number; type: string }, string[]>(
        `select u.id, u.date, u.source, u.title, u.topics, u.importance, u.type from units u
         join unit_topics t on t.unit = u.id where t.topic = ?${involving} order by u.date, u.id`
      )
      .all(wanted, ...args);
    return [
      `${rows.length} units tagged "${wanted}"${who ? ` involving ${who}` : ""}:`,
      ...rows.map(
        (r) => `${unitLine(r)} (${r.type}, importance ${r.importance})`
      ),
    ];
  });
