import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import type { Moment } from "../records/moment";
import { INFERRED_PREFIX, type Observation } from "../records/observation";
import { Statement } from "../records/statement";
import { pagedNow } from "./closeness";
import {
  momentsNow,
  readMoments,
  readStatements,
  STATEMENTS,
  shows,
  stateOf,
} from "./ledger";
import { SURE_AT } from "./observe";
import { placed } from "./page-format";
import { record } from "./run";
import { observationsNow, readPeople } from "./who";
import { when } from "./zones";

// The fact checks: what the memory holds (`claimsNow`, which the eval judges too), and the doubtful claims drawn from
// it for the owner to answer, one per claim, frozen as he is shown them (memory/statements.jsonl).

/** A local `YYYY-MM-DD[ HH:MM]` as he'd say it: "7 Sep 23:00", with the year when it isn't this one. */
export const plain = (t: string) =>
  `${when(t.slice(0, 10)).date}${t.startsWith(String(clock().getFullYear())) ? "" : ` ${t.slice(0, 4)}`}${t.slice(10)}`;

/** A moment in plain words: "Dinner, 7 Sep 20:00–22:30, at Chez Paul; with Zoé; told Dad." */
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
  return `${m.title}${time && `, ${time}`}${m.place ? `, at ${m.place}` : ""}${roles}.`;
}

/** Where a moment is rated: the one person with a page it was with (as who.ts says today), else `events`. */
export function momentGroup(
  m: Moment,
  paged: ReadonlySet<string>,
  refOf: (ref: string) => string
) {
  const withPage = new Set(
    m.people.flatMap((p) => (p.role === "with" ? [refOf(p.ref)] : []))
  ).intersection(paged);
  return withPage.size === 1 ? ([...withPage][0] as string) : "events";
}
type Draft = Omit<Statement, "at" | "schemaVersion">;

/** Why a claim may be wrong, by rules on what is stored: who it is about is only inferred, the model was unsure. */
export type Doubt = "guessed-person" | "low-confidence";

/** An observation's doubts (the one place "doubtful" is decided): low confidence counts only beside another doubt. */
export function doubtsOf(
  o: Pick<Observation, "about" | "confidence" | "entities" | "unit">,
  refOf: (ref: string) => string
): Doubt[] {
  const found: Doubt[] = [];
  if (
    [o.about, ...o.entities].some((ref) =>
      ref ? refOf(ref).startsWith(`person:${INFERRED_PREFIX}`) : false
    )
  ) {
    found.push("guessed-person");
  }
  return found.length > 0 && o.confidence < SURE_AT
    ? [...found, "low-confidence"]
    : found;
}

export type Claim = Omit<Draft, "group"> & {
  doubts: Doubt[];
  group: Draft["group"] | null;
  importance: number;
};

/** The `n` claims he should check first: doubtful, importance 3 then 2 (never 1), more doubts, newest; none stated before or without a page. */
export const doubtful = (
  claims: Claim[],
  stated: ReadonlySet<string>,
  n: number
) =>
  claims
    .filter(
      (c): c is Claim & { group: Draft["group"] } =>
        c.group !== null &&
        c.importance > 1 &&
        c.doubts.length > 0 &&
        !stated.has(c.ref)
    )
    .toSorted(
      (a, b) =>
        b.importance - a.importance ||
        b.doubts.length - a.doubts.length ||
        b.date.localeCompare(a.date)
    )
    .slice(0, n);

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
  const moments = momentsNow(await readMoments(), people.corrections);
  const facts = observations.flatMap((o) => {
    const s = stateOf(o, standing);
    if (s.state !== "active") {
      return [];
    }
    const page = home.get(o.id);
    return [
      {
        date: o.date,
        doubts: doubtsOf(o, people.refOf),
        group: page && shows(s, page) ? page : null,
        importance: o.importance,
        kind:
          o.modality === "plan" || o.modality === "reported"
            ? o.modality
            : ("fact" as const),
        ref: o.id,
        source: o.source.channel,
        text: o.when ? `${o.text} (for ${plain(o.when)})` : o.text,
        units: [o.unit],
      },
    ];
  });
  return [
    ...facts,
    ...moments.map((m) => ({
      date: m.day,
      doubts: [],
      group: momentGroup(m, paged, people.refOf),
      importance: m.importance,
      kind: "moment" as const,
      ref: m.id,
      source: null,
      text: momentText(m, people.nameOf),
      units: m.units,
    })),
  ];
}

/** Draws the `n` claims he should check first (`doubtful`) into memory/statements.jsonl, frozen as he is shown them. The caller holds the lock. */
export async function drawDoubtful(n: number) {
  const rec = record("memory.statements", { n });
  const [claims, stated] = await Promise.all([claimsNow(), readStatements()]);
  const drawn = doubtful(claims, new Set(stated.map((s) => s.ref)), n).map(
    ({ doubts, group, importance, ...c }) => ({
      doubts,
      statement: {
        ...c,
        at: rec.now.toISOString(),
        group,
        schemaVersion: 1 as const,
      },
    })
  );
  await appendJsonl(
    STATEMENTS,
    Statement,
    drawn.map((d) => d.statement)
  );
  rec.end({
    added: drawn.length,
    failed: 0,
    total: stated.length + drawn.length,
  });
  return drawn;
}
