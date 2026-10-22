import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import { type Moment, Statement } from "../schema";
import { pagedNow } from "./closeness";
import {
  digest,
  momentsNow,
  readMoments,
  readStatements,
  STATEMENTS,
  shows,
  stateOf,
} from "./ledger";
import { placed } from "./page";
import { record } from "./run";
import { observationsNow, readPeople } from "./who";
import { when } from "./zones";

// The truth benchmark: true-or-false statements drawn from what the memory holds (`claimsNow`, which the eval judges
// too), one per claim, grouped by the page the claim lives on so the owner rates one context at a time.

/** A local `YYYY-MM-DD[ HH:MM]` as he'd say it: "7 Sep 23:00", with the year when it isn't this one. */
export const plain = (t: string) =>
  `${when(t.slice(0, 10)).date}${t.startsWith(String(clock().getFullYear())) ? "" : ` ${t.slice(0, 4)}`}${t.slice(10)}`;

/** A moment in plain words: "Happened: Dinner, 7 Sep 20:00–22:30, at Chez Paul; with Zoé; told Dad." */
export function momentText(m: Moment, name: (ref: string) => string) {
  const end = m.end?.startsWith(m.start?.slice(0, 10) ?? "-")
    ? m.end.slice(11)
    : m.end && plain(m.end);
  const time = [m.start && plain(m.start), end].filter(Boolean).join("–");
  const roles = (["with", "organizer", "told"] as const)
    .map((role) => {
      const them = m.people
        .filter((p) => p.role === role)
        .map((p) => name(p.ref));
      return them.length > 0 ? `; ${role} ${them.join(", ")}` : "";
    })
    .join("");
  return `${m.status[0]?.toUpperCase()}${m.status.slice(1)}: ${m.title}${time && `, ${time}`}${m.place ? `, at ${m.place}` : ""}${roles}.`;
}

/** Where a moment is rated: the one person with a page it was with (as who.ts says today), else `events`; never an unsure one. */
export function momentGroup(
  m: Moment,
  paged: ReadonlySet<string>,
  refOf: (ref: string) => string
) {
  if (m.status === "unsure") {
    return null;
  }
  const withPage = new Set(
    m.people.flatMap((p) => (p.role === "with" ? [refOf(p.ref)] : []))
  ).intersection(paged);
  return withPage.size === 1 ? ([...withPage][0] as string) : "events";
}
type Draft = Omit<Statement, "at" | "schemaVersion">;

/** `list` in rounds of `key`: the first of each key, then the second of each, and so on; list order within a round. */
const roundRobin = <T>(list: T[], key: (t: T) => string) => {
  const seen = new Map<string, number>();
  return list
    .map((t) => {
      const n = (seen.get(key(t)) ?? 0) + 1;
      seen.set(key(t), n);
      return { n, t };
    })
    .toSorted((a, b) => a.n - b.n)
    .map((r) => r.t);
};

/**
 * `n` drafts spread evenly: one of each group first, then a second of each, and so on; within a group round its kinds,
 * within a kind its channels, within a channel its months. A fixed shuffle (a hash of the claim id) orders the rest.
 */
export function spread(pool: Draft[], n: number) {
  const hash = (d: Draft) => digest("sha1", d.claim, 8);
  const keys = (d: Draft) => [d.group, d.kind, d.source, d.date.slice(0, 7)];
  // Finest key first: each pass keeps the previous order within its rounds, so the group (the last pass) leads.
  return [4, 3, 2, 1]
    .reduce(
      (list, depth) =>
        roundRobin(list, (d) => keys(d).slice(0, depth).join("|")),
      pool.toSorted((a, b) => hash(a).localeCompare(hash(b)))
    )
    .slice(0, n);
}

export type Claim = Omit<Draft, "group"> & { group: Draft["group"] | null };

/**
 * What the memory holds now, in the words it is stated and judged in: the active observations and the moments.
 * `group` is where the owner would rate it, or null: an observation's home page when it is a line there (`placed`,
 * not hidden on it); a moment's `momentGroup`.
 */
export async function claimsNow(): Promise<Claim[]> {
  const people = await readPeople();
  const { observations, standing } = await observationsNow(people);
  const paged = await pagedNow(people.truth);
  const { homes } = placed(observations, people.truth, paged);
  const home = new Map(
    [...homes].flatMap(([page, list]) => list.map(({ o }) => [o.id, page]))
  );
  const facts = observations.flatMap((o) => {
    const s = stateOf(o, standing);
    if (s.state !== "active") {
      return [];
    }
    const page = home.get(o.id);
    return [
      {
        claim: o.id,
        date: o.date,
        group: page && shows(s, page) ? page : null,
        kind:
          o.modality === "plan" || o.modality === "reported"
            ? o.modality
            : ("fact" as const),
        source: o.source.channel,
        text: o.when ? `${o.text} (for ${plain(o.when)})` : o.text,
        units: [o.unit],
      },
    ];
  });
  const moments = momentsNow(await readMoments(), people.corrections).map(
    (m) => ({
      claim: m.id,
      date: m.day,
      group: momentGroup(m, paged, people.refOf),
      kind: "moment" as const,
      source: null,
      text: momentText(m, people.nameOf),
      units: m.units,
    })
  );
  return [...facts, ...moments];
}

/** Adds `n` statements for claims not stated yet to memory/statements.jsonl. The caller holds the lock. */
export async function addStatements(n: number) {
  const rec = record("memory.statements", { n });
  const [claims, stated] = await Promise.all([claimsNow(), readStatements()]);
  const have = new Set(stated.map((s) => s.claim));
  const pool = claims.flatMap(({ group, ...c }) =>
    group && !have.has(c.claim) ? [{ ...c, group }] : []
  );
  const drawn = spread(pool, n).map((d) => ({
    ...d,
    at: rec.now.toISOString(),
    schemaVersion: 1 as const,
  }));
  await appendJsonl(STATEMENTS, Statement, drawn);
  return rec.end({
    added: drawn.length,
    failed: 0,
    total: stated.length + drawn.length,
  });
}
