import { INFERRED_USE_AT } from "../records/observation";
import { readUnitsFor, readUnresolved } from "./ledger";
import { clip, normalize } from "./units";
import { observationsNow, readPeople } from "./who";

const EXAMPLE_MAX = 80;

/**
 * `bun life memory unresolved`: for Claude. The people Life inferred (who it thinks they are, how sure, and how many
 * observations are about them), then the names it still cannot place, most seen first, with the days they appeared
 * on and an example unit, and the Contacts cards whose name and handle disagree. Nothing here waits on the owner; when he says who someone is, Claude records it with
 * `bun life memory correct`.
 */
export async function unresolved(top = 25) {
  const [rows, people] = await Promise.all([readUnresolved(), readPeople()]);
  const { apart, inferred, names: nameOf, resolve } = people;
  const cards = apart.map(
    (a) =>
      `- ${nameOf.get(a.card) ?? a.card} (${a.card}): its name and handles say ${a.people.map((p) => nameOf.get(p) ?? p).join(" and ")}`
  );
  const open = rows.filter((r) => !resolve(r.surface));
  const units = readUnitsFor(
    open.map((r) => r.unit),
    open.map((r) => r.date)
  );
  const byId = new Map(units.map((u) => [u.id, u]));
  const resolved = rows.length - open.length;
  const names = Map.groupBy(open, (r) => normalize(r.surface));
  const lines = [...names.values()]
    .sort((a, b) => b.length - a.length)
    .slice(0, top)
    .map((list) => {
      // The latest sighting whose unit still exists.
      const last = (
        list.some((r) => byId.has(r.unit))
          ? list.filter((r) => byId.has(r.unit))
          : list
      ).reduce((m, r) => (r.date > m.date ? r : m));
      const u = byId.get(last.unit);
      const surfaces = [...new Set(list.map((r) => r.surface))].join(" / ");
      const example = u
        ? `${u.date} ${u.source} "${clip(u.title, EXAMPLE_MAX)}" ${u.id}`
        : `${last.date} ${last.unit}`;
      return `- ${surfaces}: ${list.length} times, ${new Set(list.map((r) => r.date)).size} days, ${["model", "speaker"].map((v) => `${list.filter((r) => r.via === v).length} ${v}`).join(" / ")}. e.g. ${example}`;
    });
  const { observations } = await observationsNow(people);
  const about = new Map<string, number>();
  for (const o of observations) {
    for (const e of o.entities) {
      about.set(e, (about.get(e) ?? 0) + 1);
    }
  }
  const inferredPeople = [...new Map(inferred.map((p) => [p.id, p])).values()]
    .sort((a, b) => b.confidence - a.confidence)
    .map(
      (p) =>
        `- person:${p.id} (${p.confidence}${p.confidence < INFERRED_USE_AT ? ", not used" : ""}): ${p.name}, ${p.relation}${p.area ? `, ${p.area}` : ""}. ${p.surfaces.join(" / ")}; ${p.evidence.length} quotes, ${about.get(`person:${p.id}`) ?? 0} observations`
    );
  return [
    `People Life inferred (${inferredPeople.length}; used from confidence ${INFERRED_USE_AT}, below truth/ and your corrections):`,
    ...(inferredPeople.length > 0 ? inferredPeople : ["(none)"]),
    "",
    ...(cards.length > 0
      ? [
          `Contacts cards Life cannot place (${cards.length}; its name and handles say more than one person: ask him whose it is, then put its handles in truth/):`,
          ...cards,
          "",
        ]
      : []),
    `Names not placed (${names.size}; ${resolved} sightings of names that now resolve are left out). Top ${Math.min(top, names.size)}:`,
    ...lines,
  ].join("\n");
}
