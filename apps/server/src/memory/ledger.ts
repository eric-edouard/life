import { join } from "node:path";
import type { z } from "zod";
import { clock } from "../core/clock";
import { appendJsonl, filesIn, readAppended, rowsOf } from "../core/files";
import { LIFE_STATE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { Episode } from "../records/episode";
import { type Instruction, LedgerEntry } from "../records/ledger-entry";
import {
  Correction,
  Extracted,
  Imported,
  InferredPerson,
  InferredRepo,
  Observation,
  Supersession,
  Unresolved,
} from "../records/observation";
import { Rating, Statement } from "../records/statement";
import { FileEntry, MemoryLabel, Unit, Verdict } from "../records/unit";

// memory/ on disk: every path, the readers of the ledgers and what they say of an
// observation (`stateOf`: where it stands). It appends only what the steps that write hand it.

export const MEMORY = join(OWNER_DATA_DIR, "memory");
/** A run's id: its start instant with ":" written "-" (also its folder name and the `madeBy.run` of what it wrote). */
export const runId = (d: Date) => d.toISOString().replaceAll(":", "-");
const RUN_TIME = /T(\d\d)-(\d\d)-(\d\d)/;
/** Each key's last item in `list`: how every ledger's "latest line wins" is read. */
export const latestBy = <T>(list: T[], key: (x: T) => string) =>
  new Map(list.map((x) => [key(x), x]));
/** The start instant of a run id. */
export const runAt = (run: string) => run.replace(RUN_TIME, "T$1:$2:$3");

/** Runs and the search index: generated, rebuildable, not in git. */
export const OUT = join(LIFE_STATE_DIR, "memory");

export const UNITS = join(MEMORY, "units");
export const OBSERVATIONS = join(MEMORY, "observations");
export const PAGES = join(MEMORY, "pages");
/** The kinds of page, each a folder under PAGES. */
export const PAGE_KINDS = ["people", "areas"] as const;

/** The file of a person's or an area's page. */
export const pagePath = (ref: string) =>
  ref.startsWith("person:")
    ? join(PAGES, "people", `${ref.slice("person:".length)}.md`)
    : join(PAGES, "areas", `${ref.slice("area:".length)}.md`);
export const EPISODES = join(MEMORY, "episodes");
export const EXTRACTED = join(MEMORY, "extracted.jsonl");
export const UNRESOLVED = join(MEMORY, "unresolved.jsonl");
export const SUPERSESSIONS = join(MEMORY, "supersessions.jsonl");
export const CORRECTIONS = join(MEMORY, "corrections.jsonl");
/** His decisions: what his loops asked him and what he answered (records/decision.ts, memory/decisions.ts). */
export const DECISIONS = join(MEMORY, "decisions.jsonl");
export const ZONES = join(MEMORY, "zones.jsonl");
export const INFERRED = join(MEMORY, "people-inferred.jsonl");
export const CLOSENESS = join(MEMORY, "closeness.jsonl");
export const REPOS_INFERRED = join(MEMORY, "repos-inferred.jsonl");
export const IMPORTED = join(MEMORY, "imported.jsonl");
export const LEDGER = join(MEMORY, "ledger.jsonl");
const LABELS = join(MEMORY, "labels.jsonl");
const VERDICTS = join(MEMORY, "verdicts.jsonl");
export const FILES = join(MEMORY, "files.jsonl");
export const STATEMENTS = join(MEMORY, "statements.jsonl");
export const RATINGS = join(MEMORY, "ratings.jsonl");
export const SCORES = join(MEMORY, "scores.jsonl");
/** Everyone whose page is written, by ref (the inverse of `pagePath`). */
export const writtenPeople = async () =>
  (await filesIn(join(PAGES, "people"), ".md")).map(
    (f) => `person:${f.slice(0, -3)}`
  );
/** Every `.jsonl` file of a folder, by name, from the one named `from` on. */
const readFolder = async <T>(dir: string, schema: z.ZodType<T>, from = "") =>
  (await filesIn(dir))
    .filter((n) => n >= from)
    .flatMap((n) => rowsOf(join(dir, n), schema));

/** Every unit in memory/units/ (of `day` and every day after it), oldest day first. */
export const readUnits = (day = "") => readFolder(UNITS, Unit, day);
/** The units of these days only. */
export const readUnitsOf = (dates: string[]) =>
  dates.flatMap((d) => rowsOf(join(UNITS, `${d}.jsonl`), Unit));

export const readObservations = () => readFolder(OBSERVATIONS, Observation);

/** Every episode line in memory/episodes/, oldest day first. */
export const readEpisodes = () => readFolder(EPISODES, Episode);

/** The first and last day an episode covers: its start (else the day that read it) to its end (else its start). */
export const daysOf = (m: Episode) =>
  [
    (m.start ?? m.day).slice(0, 10),
    (m.end ?? m.start ?? m.day).slice(0, 10),
  ] as const;

/** Each episode as it stands: its line from the latest day that read it, with the units (and copies) of every day's line, in day order; never one the owner said is wrong or unimportant (an episode is on no page: any such correction hides it). */
export const episodesNow = (lines: Episode[], corrections: Correction[]) =>
  [...Map.groupBy(lines, (m) => m.id).values()].flatMap((ls) => {
    const m = ls.at(-1) as Episode;
    const all = (k: "copies" | "units") => [
      ...new Set(ls.flatMap((l) => l[k])),
    ];
    return hiding(corrections, m.id).length > 0
      ? []
      : [{ ...m, copies: all("copies"), units: all("units") }];
  });

/**
 * Each unit's episode, the one its facts sit under: of the episodes holding it, the one reaching furthest forward (its
 * latest day), then the smallest (a dinner, not the trip around it), so a question is read with its answer.
 */
export const readBy = (episodes: Episode[]) =>
  new Map(
    episodes
      .toSorted(
        (a, b) => a.day.localeCompare(b.day) || b.units.length - a.units.length
      )
      .flatMap((m) => m.units.map((u) => [u, m] as const))
  );

/** Each unit's latest extraction: its last line in extracted.jsonl. */
export const latestExtractions = (ledger: Extracted[]) =>
  latestBy(ledger, (e) => e.unit);

/** The units an observation can stand on: in memory/units and not dropped by a code rule. */
export const liveUnits = (units: Unit[]) =>
  new Set(units.flatMap((u) => (u.drop ? [] : [u.id])));

/**
 * True when `o`'s unit is live and `o` comes from that unit's latest extraction (its last line in extracted.jsonl), or
 * the unit has none: a unit read again, under another content hash or another prompt version, leaves its older facts
 * in the ledger, replaced; a unit gone (a conversation regrouped) or dropped (a code rule) leaves them all.
 */
export function isCurrent(
  { latest, live }: Pick<Standing, "latest" | "live">,
  o: Observation
) {
  const l = latest.get(o.unit);
  return (
    live.has(o.unit) &&
    (!l || (l.unitHash === o.madeBy.unitHash && l.run === o.madeBy.run))
  );
}

/**
 * Whether an observation is new since `at` (none: all are): no observation of `all` made by then cites its source line
 * (the exact message or transcript turn). A re-read (a prompt bump, a re-summarized chapter) cites the same lines, so
 * nothing in it is new; a chat-day that grew, or a lifelog job transcribed again, has new lines.
 */
export function newSince(all: Observation[], at?: string) {
  const run = at ? runId(new Date(at)) : "";
  const cited = new Set(
    all.flatMap((o) => (o.madeBy.run <= run ? [o.source.ref] : []))
  );
  return (o: Observation) => !cited.has(o.source.ref);
}

/** A supersession as `stateOf` reads it: a line of supersessions.jsonl, or one his `outdated` correction retires (`outdatedBy`). */
type Retirement = Omit<Supersession, "madeBy">;

/**
 * Observations a newer one replaced (memory/supersessions.jsonl), or he said are outdated (`by` itself): id -> the first
 * retirement recorded whose `by` is still current (a replacement re-read away no longer retires anything).
 */
export const retiredBy = (list: Retirement[], current: Set<string>) => {
  const out = new Map<string, Retirement>();
  for (const s of list) {
    if (current.has(s.by) && !out.has(s.observation)) {
      out.set(s.observation, s);
    }
  }
  return out;
};

/** The owner's answers to the fact checks: the latest for each claim (null: taken back). */
export const latestRatings = (list: Rating[]) => latestBy(list, (r) => r.ref);

export const readRatings = () => latestRatings(rowsOf(RATINGS, Rating));

/**
 * What each answer means, decided here only: the correction it reads as (false and partly hide the claim as wrong,
 * outdated retires it as history), and what it says to the eval (`fact`: true, false, or null to leave it out).
 */
const ANSWERS: Record<
  NonNullable<Rating["answer"]>,
  { correction: "wrong" | "outdated" | null; fact: boolean | null }
> = {
  false: { correction: "wrong", fact: false },
  outdated: { correction: "outdated", fact: true },
  partly: { correction: "wrong", fact: null },
  skip: { correction: null, fact: null },
  true: { correction: null, fact: true },
};

/** His latest answers as the corrections they read as (`ANSWERS`), his note with them: an undo or a later answer lifts one. */
export const ratedCorrections = (latest: Map<string, Rating>): Correction[] =>
  [...latest.values()].flatMap(({ answer, at, note, ref }) => {
    const kind = answer && ANSWERS[answer].correction;
    return kind
      ? [
          {
            at,
            kind,
            note: `rated ${answer}${note ? `: ${note}` : ""}`,
            observations: [ref],
            schemaVersion: 1,
          } as Correction,
        ]
      : [];
  });

/**
 * What his `outdated` corrections retire (true then, not anymore), as extraction retires a fact later evidence closed:
 * kept as history, not wrong. `by` is the observation itself (no successor: readers of `by` skip it); `why` his words.
 */
export const outdatedBy = (corrections: Correction[]): Retirement[] =>
  corrections.flatMap((c) =>
    c.kind === "outdated"
      ? c.observations.map((id) => ({
          at: c.at,
          by: id,
          observation: id,
          schemaVersion: 1 as const,
          validTo: c.at.slice(0, 10), // his word's UTC day (a local day needs zones.ts, which imports this file)
          why: c.note ?? "outdated",
        }))
      : []
  );

/** What the owner said: memory/corrections.jsonl, then his answers to the fact checks (`ratedCorrections`). */
export const readCorrections = (): Correction[] => [
  ...rowsOf(CORRECTIONS, Correction),
  ...ratedCorrections(readRatings()),
];

/** The ledgers that decide where an observation stands: the owner's corrections, each unit's latest extraction, the supersessions. */
export interface Standing {
  corrections: Correction[];
  latest: Map<string, Extracted>;
  live: Set<string>;
  retired: Map<string, Retirement>;
}

/** The extraction, unit and supersession ledgers (with what his `outdated` corrections retire after them), with the corrections (and the observations) the caller already holds. */
export async function readStanding(
  corrections: Correction[],
  read: Observation[] | Promise<Observation[]> = readObservations()
): Promise<Standing> {
  const [units, observations] = await Promise.all([readUnits(), read]);
  const extracted = rowsOf(EXTRACTED, Extracted);
  const supersessions = rowsOf(SUPERSESSIONS, Supersession);
  const c = { latest: latestExtractions(extracted), live: liveUnits(units) };
  const current = new Set(
    observations.flatMap((o) => (isCurrent(c, o) ? [o.id] : []))
  );
  const retirements = [...supersessions, ...outdatedBy(corrections)];
  return { corrections, ...c, retired: retiredBy(retirements, current) };
}

/**
 * When the owner last said each unit was read wrong: a `reread` of it, or a `wrong` on an episode of `episodes` it stands
 * on (its day is read again, with his note, `earlierFor`). Episodes and extraction read it again if they read it before.
 */
export const rereadAt = (corrections: Correction[], episodes: Episode[]) => {
  const unitsOf = Map.groupBy(episodes, (m) => m.id);
  return new Map(
    [
      ...latestBy(
        corrections.flatMap((c) => {
          if (c.kind === "reread") {
            return c.units.map((unit) => ({ at: c.at, unit }));
          }
          return c.kind === "wrong"
            ? c.observations.flatMap((id) =>
                (unitsOf.get(id) ?? []).flatMap((m) =>
                  m.units.map((unit) => ({ at: c.at, unit }))
                )
              )
            : [];
        }),
        (r) => r.unit
      ),
    ].map(([unit, r]) => [unit, r.at])
  );
};

/** Whether the owner said `unit` was read wrong after a reading of it at `at` (`rereadAt`): episodes and extraction alike. */
export const isRereadSince = (
  rereads: Map<string, string>,
  unit: string,
  at: string
) => {
  const since = rereads.get(unit);
  return !!since && Date.parse(since) > Date.parse(at);
};

/** A correction that hides observations (`wrong`, `not-important`): everywhere, or on its `page` only. */
export const hides = (c: Correction) =>
  c.kind === "wrong" || c.kind === "not-important" ? c : null;

type Hider = NonNullable<ReturnType<typeof hides>>;

// ponytail: keyed by the list itself, so a list must not change after it is read (none does).
const hidersOf = new WeakMap<Correction[], Map<string, readonly Hider[]>>();

/** The owner's corrections hiding `id`, in his order: everywhere (no page), or on a page. Indexed once per list. */
export const hiding = (corrections: Correction[], id: string) => {
  let index = hidersOf.get(corrections);
  if (!index) {
    index = new Map();
    for (const h of corrections.flatMap((c) => hides(c) ?? [])) {
      for (const o of new Set(h.observations)) {
        index.set(o, [...(index.get(o) ?? []), h]);
      }
    }
    hidersOf.set(corrections, index);
  }
  return index.get(id) ?? [];
};

/**
 * Where an observation stands: the one rule the index, the pages and the status reads go by. First match wins: `hidden`
 * (the owner said wrong or not important, everywhere), `gone` (its unit no longer exists or a code rule drops it now),
 * `replaced` (its unit was read again and the newer extraction counts), `retired` (a newer observation superseded it, or he said it is outdated: `by` itself; still indexed, with `by`, and still cited on a page, never new
 * there), `active`. `hiddenOn`: the pages the owner hid it on; it stays indexed. An observation is a model's reading,
 * its quote checked against the source: `active` does not mean verified.
 */
export function stateOf(o: Observation, s: Standing) {
  const hid = hiding(s.corrections, o.id);
  const everywhere = hid.find((c) => !c.page);
  if (everywhere) {
    const { at, kind, note } = everywhere;
    return {
      at,
      correction: kind,
      note: note ?? null,
      state: "hidden" as const,
    };
  }
  if (!s.live.has(o.unit)) {
    return { state: "gone" as const };
  }
  if (!isCurrent(s, o)) {
    const l = s.latest.get(o.unit);
    return {
      at: l?.at ?? null,
      by: l?.run ?? null,
      state: "replaced" as const,
    };
  }
  const hiddenOn = hid.flatMap((c) => (c.page ? [c.page] : []));
  const r = s.retired.get(o.id);
  if (r) {
    const { at, by, page, validTo, why } = r;
    return {
      at,
      by,
      hiddenOn,
      page,
      state: "retired" as const,
      validTo,
      why,
    };
  }
  return { hiddenOn, state: "active" as const };
}
type State = ReturnType<typeof stateOf>;

/** Whether an observation in that state shows: in the index (no page), or on `page`. */
export const shows = (s: State, page?: string) =>
  (s.state === "active" || s.state === "retired") &&
  !(page && s.hiddenOn.includes(page));

/** The observations that show in the index: neither hidden everywhere nor replaced. */
export const shownOf = (list: Observation[], standing: Standing) =>
  list.filter((o) => shows(stateOf(o, standing)));

/** Stamps and checks what the owner said (the CLI's `correct` and the connector's) and appends it; throws when invalid. */
export async function recordCorrection(said: unknown) {
  // Stamped when recorded, whatever the caller sent: a future `at` would re-read a unit every night until then.
  const correction = Correction.parse({
    ...(said as object),
    at: clock().toISOString(),
    schemaVersion: 1,
  });
  await appendJsonl(CORRECTIONS, Correction, [correction]);
  return correction;
}

/** The fact checks he was shown: every statement, in the order it was drawn. */
export const readStatements = () => rowsOf(STATEMENTS, Statement);

/** His rated statements as facts, true or false as `ANSWERS` says (skip and partly left out). */
export function ratedFacts() {
  const ratings = readRatings();
  return readStatements().flatMap((s) => {
    const answer = ratings.get(s.ref)?.answer;
    const fact = answer ? ANSWERS[answer].fact : null;
    return answer && fact !== null
      ? [
          {
            date: s.date,
            fact: s.text,
            id: s.ref,
            // An episode has no closed state.
            outdated:
              ANSWERS[answer].correction === "outdated" && s.kind !== "episode",
            true: fact,
            units: s.units,
          },
        ]
      : [];
  });
}

/** Appends the owner's answer to a fact check he was shown (`rate`), with his why; a later answer replaces it. */
export function recordRating(
  ref: string,
  answer: NonNullable<Rating["answer"]>,
  note?: string
) {
  if (!readStatements().some((s) => s.ref === ref)) {
    throw new Error(`no fact check ${ref} in memory/statements.jsonl`);
  }
  return appendJsonl(RATINGS, Rating, [
    {
      answer,
      at: clock().toISOString(),
      ...(note ? { note } : {}),
      ref,
      schemaVersion: 1,
    },
  ]);
}

export const readUnresolved = () => rowsOf(UNRESOLVED, Unresolved);

/** The actions ledger, in order (read once per process, then its new lines). */
export const readLedger = (): readonly LedgerEntry[] =>
  readAppended<LedgerEntry, LedgerEntry[]>(
    LEDGER,
    LedgerEntry,
    (last) => [...(last ?? [])],
    (all, e) => {
      all.push(e);
    }
  );

/** One actions ledger line, null for a blank one. */
export const parseLedgerEntry = (line: string) =>
  line ? LedgerEntry.parse(JSON.parse(line)) : null;

export interface Task {
  ask: LedgerEntry & { instruction: Instruction };
  /** Its own lines in ledger order. */
  lines: LedgerEntry[];
}

/** The actions ledger as asks, each with its own lines (an agent's updates and replies before 2 Nov 2026). */
export function tasksOf(entries = readLedger()) {
  const tasks = new Map<string, Task>();
  for (const a of entries) {
    if (a.kind === "ask" && a.instruction) {
      tasks.set(a.id, { ask: { ...a, instruction: a.instruction }, lines: [] });
    } else {
      tasks.get(a.target)?.lines.push(a);
    }
  }
  return [...tasks.values()];
}

/** The agent's last update of an ask (before 2 Nov 2026), and its outcome once done. */
export const lastUpdate = (t: Task) =>
  t.lines.findLast((l) => l.kind === "update");

export const readInferred = () => rowsOf(INFERRED, InferredPerson);

/** The repos Life inferred: the latest record for each repo wins. */
export const readInferredRepos = () => [
  ...latestBy(rowsOf(REPOS_INFERRED, InferredRepo), (g) => g.repo).values(),
];

/** The imported conversations the import step kept (`<source>:<id>`, a unit's key): the latest line for each wins. */
export const keptConversations = () =>
  new Set(
    [
      ...latestBy(rowsOf(IMPORTED, Imported), (i) => i.conversation).values(),
    ].flatMap((i) => (i.keep ? [i.conversation] : []))
  );

/** The owner's labels: the latest one for each unit wins. */
export const readLabels = () => [
  ...latestBy(rowsOf(LABELS, MemoryLabel), (l) => l.unitId).values(),
];

/** What Life read off each file a message carried: the latest line for each ref wins. */
export const readFiles = (): ReadonlyMap<string, FileEntry> =>
  readAppended<FileEntry, Map<string, FileEntry>>(
    FILES,
    FileEntry,
    (last) => new Map(last),
    (all, e) => {
      all.set(e.ref, e);
    }
  );

/** Verdicts by unit and content: the latest line for each (unit, hash) wins. */
export type Verdicts = ReadonlyMap<string, Verdict>;
export const verdictKey = (unit: string, hash: string) => `${unit}|${hash}`;

export const readVerdicts = (): Verdicts =>
  readAppended<Verdict, Map<string, Verdict>>(
    VERDICTS,
    Verdict,
    (last) => new Map(last),
    (all, v) => {
      all.set(verdictKey(v.unit, v.hash), v);
    }
  );

export const appendVerdicts = (list: Verdict[]) =>
  appendJsonl(VERDICTS, Verdict, list);

/**
 * The one way to ask what the verdicts made of a unit: the verdict on its current content, or undefined when it has none
 * (not judged yet, judged on older content, or dropped by a code rule).
 */
export const verdictOf = (verdicts: Verdicts, u: Unit) =>
  u.drop ? undefined : verdicts.get(verdictKey(u.id, u.hash));
