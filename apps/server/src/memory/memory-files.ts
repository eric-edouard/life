import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { clock, DAY } from "../core/clock";
import {
  appendJsonl,
  filesIn,
  keptReader,
  linesOf,
  readAppended,
  rowsOf,
} from "../core/files";
import { LIFE_STATE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { git } from "../core/proc";
import { openReadOnly } from "../core/sqlite";
import { Episode } from "../records/episode";
import { FactCheck, FactCheckAnswer } from "../records/fact-check";
import { type Instruction, LedgerEntry } from "../records/ledger-entry";
import {
  ContactPerson,
  Correction,
  Extracted,
  Imported,
  InferredPerson,
  InferredRepo,
  Observation,
  Supersession,
  Unresolved,
} from "../records/observation";
import { FileEntry, MemoryLabel, Unit, Verdict } from "../records/unit";

// memory/ on disk and its search index: every path, the readers of the ledgers and of the index, and what the ledgers
// say of an observation (`observationStatusOf`: where it stands), and commits them to the data repo (`commitMemory`). It appends only what
// the steps that write hand it.

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
/** Where things stand with him and each person close to him (`memory/situations.ts`), one file per person. */
export const SITUATIONS = join(MEMORY, "situations");
export const situationPath = (ref: string) =>
  join(SITUATIONS, `${ref.slice("person:".length)}.json`);
/** What each person with a page is like, wants and can give, and how they and he write (`memory/personas.ts`), one file per person. */
export const PERSONAS = join(MEMORY, "personas");
export const personaPath = (ref: string) =>
  join(PERSONAS, `${ref.slice("person:".length)}.json`);
/** The links between observations (`memory/links.ts`): one line per judged batch, append-only. */
export const LINKS = join(MEMORY, "links.jsonl");
/** Each person's past months with him, summarised once, and their story (`memory/histories.ts`), one file per person. */
export const HISTORIES = join(MEMORY, "histories");
export const historyPath = (ref: string) =>
  join(HISTORIES, `${ref.slice("person:".length)}.json`);
/**
 * What each read of an exchange answered (`memory/exchange-reads.ts`), append-only, one file per month of the batch's
 * first message, read as an instant (UTC on purpose: a file's name never moves), so old history is never touched again.
 */
export const READ_REPLIES = join(MEMORY, "read-replies");
export const readReplyPath = (firstAt: string, dir = READ_REPLIES) =>
  join(dir, `${firstAt.slice(0, 7)}.jsonl`);
/** What each publication of units read: its days and sources (`publishUnits`, read by `coverage.ts`). Append-only. */
export const PUBLICATIONS = join(MEMORY, "publications.jsonl");
export const EPISODES = join(MEMORY, "episodes");
export const EXTRACTED = join(MEMORY, "extracted.jsonl");
export const UNRESOLVED = join(MEMORY, "unresolved.jsonl");
export const SUPERSESSIONS = join(MEMORY, "supersessions.jsonl");
export const CORRECTIONS = join(MEMORY, "corrections.jsonl");
export const ZONES = join(MEMORY, "zones.jsonl");
export const INFERRED = join(MEMORY, "people-inferred.jsonl");
/** The people his Contacts name, appended by the night (`contact-people.ts`). */
export const CONTACT_PEOPLE = join(MEMORY, "people-contacts.jsonl");
export const CLOSENESS = join(MEMORY, "closeness.jsonl");
/** The appointments ahead of him (`memory/appointments.ts`), rewritten whole. */
export const APPOINTMENTS = join(MEMORY, "appointments.json");
/** The events the calendar sync wrote for them and those he removed (`host/appointments-calendar.ts`), append-only. */
export const APPOINTMENT_EVENTS = join(MEMORY, "appointment-events.jsonl");
export const REPOS_INFERRED = join(MEMORY, "repos-inferred.jsonl");
export const IMPORTED = join(MEMORY, "imported.jsonl");
export const LEDGER = join(MEMORY, "ledger.jsonl");
const LABELS = join(MEMORY, "labels.jsonl");
const VERDICTS = join(MEMORY, "verdicts.jsonl");
export const FILES = join(MEMORY, "files.jsonl");
export const FACT_CHECKS = join(MEMORY, "fact-checks.jsonl");
export const FACT_CHECK_ANSWERS = join(MEMORY, "fact-check-answers.jsonl");
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

/** The search index (`buildIndex`, index-writer.ts). */
export const INDEX = join(OUT, "index.sqlite");
/** Rebuildable source-backed search passages, independent of the index (`passages.ts`). */
export const PASSAGES = join(OUT, "passages.sqlite");
/** Search by meaning's vectors, by text (`vectors.ts`): apart from the index, which every rebuild drops whole. */
export const VECTORS = join(OUT, "vectors.sqlite");
/** What code counts between him and each person, exchange by exchange, rebuilt whole each night (`exchange-counts.ts`). */
export const EXCHANGE_COUNTS = join(OUT, "exchange-counts.json");
/** The local days the pendant recorded on, as lifelog says, rebuilt whole each night (`recorded-days.ts`). */
export const RECORDED_DAYS = join(OUT, "recorded-days.json");

/**
 * Reads the index read-only with `read`, or null when it isn't built. A rebuild meanwhile is safe (`buildIndex`); the
 * wait covers the moment it checkpoints its log into the file. `read` can't be async: the index closes when it returns.
 */
export function readIndex<T>(
  read: (db: Database) => T extends PromiseLike<unknown> ? never : T
): T | null {
  if (!existsSync(INDEX)) {
    return null;
  }
  const db = openReadOnly(INDEX);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Units named by their references: the index supplies their days, with source dates for units not indexed yet. */
export function readUnitsFor(ids: string[], dates: string[] = []) {
  if (ids.length === 0) {
    return [];
  }
  const wanted = new Set(ids);
  const indexed =
    readIndex((db) =>
      db
        .query<{ date: string }, [string]>(
          "select distinct date from units where id in (select value from json_each(?))"
        )
        .all(JSON.stringify(ids))
        .map((r) => r.date)
    ) ?? [];
  return readUnitsOf([...new Set([...indexed, ...dates])]).filter((u) =>
    wanted.has(u.id)
  );
}

/** One unit by id: its indexed day, else the latest seven stored days awaiting an index rebuild. */
export async function readUnit(id: string) {
  const [indexed] = readUnitsFor([id]);
  if (indexed) {
    return indexed;
  }
  const recent = (await filesIn(UNITS))
    .slice(-7)
    .map((name) => name.slice(0, -6));
  return readUnitsOf(recent).find((u) => u.id === id);
}

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
const liveIn = keptReader((path) => liveUnits(rowsOf(path, Unit)));
/** The live units (`liveUnits`), a day's file read again only once it changed (`keptReader`). */
export const readLiveUnits = async () =>
  new Set((await filesIn(UNITS)).flatMap((n) => [...liveIn(join(UNITS, n))]));

/** An observation as where it stands is decided (`isCurrent`), with its line in its month, blanks counted. */
export interface Origin extends Pick<Observation, "id" | "unit"> {
  madeBy: Pick<Observation["madeBy"], "run" | "unitHash">;
  n: number;
}
const originsIn = keptReader((path): Origin[] =>
  linesOf(path).flatMap((line, n) => {
    if (!line) {
      return [];
    }
    const { id, madeBy, unit } = Observation.parse(JSON.parse(line));
    return [
      { id, madeBy: { run: madeBy.run, unitHash: madeBy.unitHash }, n, unit },
    ];
  })
);
/** Each observation month's origins, by its file name: a month is read again only once it changed (`keptReader`). */
export const readOrigins = async () =>
  new Map(
    (await filesIn(OBSERVATIONS)).map((m) => [
      m,
      originsIn(join(OBSERVATIONS, m)),
    ])
  );

/**
 * True when `o`'s unit is live and `o` comes from that unit's latest extraction (its last line in extracted.jsonl), or
 * the unit has none: a unit read again, under another content hash or another prompt version, leaves its older facts
 * in the ledger, replaced; a unit gone (a conversation regrouped) or dropped (a code rule) leaves them all.
 */
export function isCurrent(
  { latest, live }: Pick<ObservationStatusInputs, "latest" | "live">,
  o: Pick<Origin, "madeBy" | "unit">
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

/** A supersession as `observationStatusOf` reads it: a line of supersessions.jsonl, or one his `outdated` correction retires (`outdatedBy`). */
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

/** The owner's answers to the fact checks: the latest for each memory line (null: taken back). */
export const latestFactCheckAnswers = (list: FactCheckAnswer[]) =>
  latestBy(list, (r) => r.ref);

export const readFactCheckAnswers = () =>
  latestFactCheckAnswers(rowsOf(FACT_CHECK_ANSWERS, FactCheckAnswer));

/**
 * What each answer means, decided here only: the correction it reads as (false and partly hide the memory line as wrong,
 * outdated retires it as history), and what it says to the eval (`fact`: true, false, or null to leave it out).
 */
const ANSWERS: Record<
  NonNullable<FactCheckAnswer["answer"]>,
  { correction: "wrong" | "outdated" | null; fact: boolean | null }
> = {
  false: { correction: "wrong", fact: false },
  outdated: { correction: "outdated", fact: true },
  partly: { correction: "wrong", fact: null },
  skip: { correction: null, fact: null },
  true: { correction: null, fact: true },
};

/** His latest answers as the corrections they read as (`ANSWERS`), his note with them: an undo or a later answer lifts one. */
export const answeredFactCheckCorrections = (
  latest: Map<string, FactCheckAnswer>
): Correction[] =>
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

/** What the owner said: memory/corrections.jsonl, then his answers to the fact checks (`answeredFactCheckCorrections`). */
export const readCorrections = (): Correction[] => [
  ...rowsOf(CORRECTIONS, Correction),
  ...answeredFactCheckCorrections(readFactCheckAnswers()),
];

/** The ledgers that decide where an observation stands: the owner's corrections, each unit's latest extraction, the supersessions. */
export interface ObservationStatusInputs {
  corrections: Correction[];
  latest: Map<string, Extracted>;
  live: Set<string>;
  retired: Map<string, Retirement>;
}

/**
 * The extraction, unit and supersession ledgers (with what his `outdated` corrections retire after them), with the
 * corrections (and the observations, else their origins) the caller already holds.
 */
export async function readObservationStatusInputs(
  corrections: Correction[],
  read?: Promise<Observation[]>
): Promise<ObservationStatusInputs> {
  const [live, observations] = await Promise.all([
    readLiveUnits(),
    read ?? readOrigins().then((months) => [...months.values()].flat()),
  ]);
  const extracted = rowsOf(EXTRACTED, Extracted);
  const supersessions = rowsOf(SUPERSESSIONS, Supersession);
  const c = { latest: latestExtractions(extracted), live };
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
export function observationStatusOf(
  o: Observation,
  s: ObservationStatusInputs
) {
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
type ObservationStatus = ReturnType<typeof observationStatusOf>;

/** Whether an observation in that state shows: in the index (no page), or on `page`. */
export const shows = (s: ObservationStatus, page?: string) =>
  (s.state === "active" || s.state === "retired") &&
  !(page && s.hiddenOn.includes(page));

/** The observations that show in the index: neither hidden everywhere nor replaced. */
export const shownOf = (
  list: Observation[],
  statusInputs: ObservationStatusInputs
) => list.filter((o) => shows(observationStatusOf(o, statusInputs)));

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

/** The fact checks he was shown: every one, in the order it was drawn. */
export const readFactChecks = () => rowsOf(FACT_CHECKS, FactCheck);

/** How long a drawn fact check stays open; after that it counts as skipped (derived, nothing written). */
const FACT_CHECK_OPEN = 7 * DAY;
/** The fact checks open now (the one place it is decided): drawn under 7 days ago, not answered. */
export function openFactChecks(now = clock().getTime()) {
  const answers = readFactCheckAnswers();
  return readFactChecks().filter(
    (s) =>
      !answers.get(s.ref)?.answer && now - Date.parse(s.at) < FACT_CHECK_OPEN
  );
}

/** The fact checks he answered, as the eval's facts: true or false as `ANSWERS` says (skip and partly left out); episodes' too. */
export function answeredFactChecks() {
  const answers = readFactCheckAnswers();
  return readFactChecks().flatMap((s) => {
    const answer = answers.get(s.ref)?.answer;
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
export function recordFactCheckAnswer(
  ref: string,
  answer: NonNullable<FactCheckAnswer["answer"]>,
  note?: string
) {
  if (!readFactChecks().some((s) => s.ref === ref)) {
    throw new Error(`no fact check ${ref} in memory/fact-checks.jsonl`);
  }
  return appendJsonl(FACT_CHECK_ANSWERS, FactCheckAnswer, [
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

/** The lines of the people his Contacts name, as appended (`contactsNow` folds them). */
export const readContactLines = () => rowsOf(CONTACT_PEOPLE, ContactPerson);

/** The repos Life inferred: the latest record for each repo wins. */
export const readInferredRepos = () => [
  ...latestBy(rowsOf(REPOS_INFERRED, InferredRepo), (g) => g.repo).values(),
];

/** The import step's judgments by conversation (`<source>:<id>`, a unit's key): the latest line for each wins. */
export const readJudgments = (): ReadonlyMap<string, Imported> =>
  readAppended<Imported, Map<string, Imported>>(
    IMPORTED,
    Imported,
    (last) => new Map(last),
    (all, i) => {
      all.set(i.conversation, i);
    }
  );

/** The imported conversations the import step kept. */
export const keptConversations = () =>
  new Set(
    [...readJudgments().values()].flatMap((i) =>
      i.keep ? [i.conversation] : []
    )
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

/** The episodes as they stand now that `keep` keeps, by when they happen. */
// ponytail: every episode line is read (≈25 MB at 10 years): `person` and `day` need them all (a person's history,
// `readBy`); index the episodes if a read of them shows up.
export const episodesWhere = async (keep: (m: Episode) => boolean) => {
  const [lines, corrections] = await Promise.all([
    readEpisodes(),
    readCorrections(),
  ]);
  return episodesNow(lines, corrections)
    .filter(keep)
    .toSorted((a, b) => daysOf(a)[0].localeCompare(daysOf(b)[0]));
};

/** Commits the given paths of the data repo (only those that exist), with a plain message. Nothing to commit is fine. */
export function commitMemory(
  all: string[],
  message: string,
  dir = OWNER_DATA_DIR
) {
  // Its own repo's root, never a folder git would resolve to some repo above it (a test run's copy, a subfolder).
  if (!existsSync(join(dir, ".git"))) {
    throw new Error(`${dir} is not a repo of its own: nothing is committed`);
  }
  if (git(dir, ["remote"]).stdout.toString().trim()) {
    throw new Error(`${dir}'s repo has a remote: his data is never pushed`);
  }
  const paths = all.filter((p) => existsSync(join(dir, p)));
  git(dir, ["add", "--", ...paths]);
  if (
    git(dir, ["diff", "--cached", "--quiet", "--", ...paths]).exitCode === 0
  ) {
    return false;
  }
  const out = git(dir, ["commit", "-q", "-m", message, "--", ...paths]);
  if (out.exitCode !== 0) {
    throw new Error(`git commit failed: ${out.stderr.toString().trim()}`);
  }
  return true;
}
