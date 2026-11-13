import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import type { Episode } from "../records/episode";
import { FactCheck } from "../records/fact-check";
import { INFERRED_PREFIX, type Observation } from "../records/observation";
import { KEEP_AT } from "../records/unit";
import { pagedNow } from "./closeness";
import {
  episodesNow,
  FACT_CHECKS,
  readEpisodes,
  readFactChecks,
  shows,
  stateOf,
} from "./memory-files";
import { placed } from "./page-format";
import { SURE_AT } from "./quote-check";
import { record } from "./run";
import { observationsNow, readPeople } from "./who";
import { when } from "./zones";

// The fact checks: what the memory holds (`memoryLinesNow`, which the eval judges too), and the doubtful memory lines drawn from
// it for the owner to answer, one per line, frozen as he is shown them (memory/statements.jsonl).

/** A local `YYYY-MM-DD[ HH:MM]` as he'd say it: "7 Sep 23:00", with the year when it isn't this one. */
export const plain = (t: string) =>
  `${when(t.slice(0, 10)).date}${t.startsWith(String(clock().getFullYear())) ? "" : ` ${t.slice(0, 4)}`}${t.slice(10)}`;

/** An episode in plain words: "Dinner, 7 Sep 20:00–22:30, at Chez Paul; with Zoé; told Dad." */
export function episodeText(m: Episode, name: (ref: string) => string) {
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

/** Where an episode is rated: the one person with a page it was with (as who.ts says today), else `episodes`. */
export function episodeGroup(
  m: Episode,
  paged: ReadonlySet<string>,
  refOf: (ref: string) => string
) {
  const withPage = new Set(
    m.people.flatMap((p) => (p.role === "with" ? [refOf(p.ref)] : []))
  ).intersection(paged);
  return withPage.size === 1 ? ([...withPage][0] as string) : "episodes";
}
type Draft = Omit<FactCheck, "at" | "schemaVersion">;

/** Why a memory line may be wrong, by rules on what is stored: who it is about is only inferred, the model was unsure. */
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

export type MemoryLine = Omit<Draft, "group"> & {
  doubts: Doubt[];
  group: Draft["group"] | null;
  importance: number;
};

/** The `n` memory lines he should check first: doubtful, importance 3 then 2 (never 1), more doubts, newest; none stated before or without a page. */
export const doubtful = (
  claims: MemoryLine[],
  stated: ReadonlySet<string>,
  n: number
) =>
  claims
    .filter(
      (c): c is MemoryLine & { group: Draft["group"] } =>
        c.group !== null &&
        c.importance >= KEEP_AT &&
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
 * What the memory holds now, in the words it is stated and judged in: the active observations and the episodes.
 * `group` is where the owner would rate it, or null: an observation's home page when it is a line there (`placed`,
 * not hidden on it); an episode's `episodeGroup`.
 */
export async function memoryLinesNow(): Promise<MemoryLine[]> {
  const people = await readPeople();
  const { observations, standing } = await observationsNow(people);
  const paged = await pagedNow(people);
  const { homes } = placed(observations, people.truth, paged);
  const home = new Map(
    [...homes].flatMap(([page, list]) => list.map(({ o }) => [o.id, page]))
  );
  const episodes = episodesNow(await readEpisodes(), people.corrections);
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
    ...episodes.map((m) => ({
      date: m.day,
      doubts: [],
      group: episodeGroup(m, paged, people.refOf),
      importance: m.importance,
      kind: "episode" as const,
      ref: m.id,
      source: null,
      text: episodeText(m, people.nameOf),
      units: m.units,
    })),
  ];
}

/** Draws the `n` memory lines he should check first (`doubtful`) into memory/statements.jsonl, frozen as he is shown them. The caller holds the lock. */
export async function drawFactChecks(n: number) {
  const rec = record("memory.fact-checks", { n });
  const [claims, stated] = await Promise.all([
    memoryLinesNow(),
    readFactChecks(),
  ]);
  const drawn = doubtful(claims, new Set(stated.map((s) => s.ref)), n).map(
    ({ doubts, group, importance, ...c }) => ({
      doubts,
      factCheck: {
        ...c,
        at: rec.now.toISOString(),
        group,
        schemaVersion: 1 as const,
      },
    })
  );
  await appendJsonl(
    FACT_CHECKS,
    FactCheck,
    drawn.map((d) => d.factCheck)
  );
  rec.end({
    added: drawn.length,
    failed: 0,
    total: stated.length + drawn.length,
  });
  return drawn;
}
