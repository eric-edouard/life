import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { z } from "zod";
import {
  Action,
  Correction,
  Extracted,
  FileEntry,
  InferredPerson,
  MemoryLabel,
  Moment,
  Observation,
  Rating,
  RepoGuess,
  Statement,
  Supersession,
  Unit,
  Unresolved,
  Verdict,
} from "../schema";
import { DATA, ROOT } from "../truth";

// memory/ on disk: every path, one JSON Lines reader and appender, the readers of the ledgers and what they say of an
// observation (`stateOf`: where it stands). Reading only; the steps that write decide what to write.

const MEMORY = join(DATA, "memory");
/** A run's id: its start instant with ":" written "-" (also its folder name and the `madeBy.run` of what it wrote). */
export const runId = (d: Date) => d.toISOString().replaceAll(":", "-");
const RUN_TIME = /T(\d\d)-(\d\d)-(\d\d)/;
/** The first `n` hex of a hash of `s`: how ids and content hashes are made. */
export const digest = (algo: string, s: string | Buffer, n: number) =>
  createHash(algo).update(s).digest("hex").slice(0, n);
/** The start instant of a run id. */
export const runAt = (run: string) => run.replace(RUN_TIME, "T$1:$2:$3");

/** Runs and the search index: generated, rebuildable, not in git. */
export const OUT = join(ROOT, "derived", "memory");

export const UNITS = join(MEMORY, "units");
export const OBSERVATIONS = join(MEMORY, "observations");
export const PAGES = join(MEMORY, "pages");
export const MOMENTS = join(MEMORY, "moments");
export const EXTRACTED = join(MEMORY, "extracted.jsonl");
export const UNRESOLVED = join(MEMORY, "unresolved.jsonl");
export const SUPERSESSIONS = join(MEMORY, "supersessions.jsonl");
export const CORRECTIONS = join(MEMORY, "corrections.jsonl");
export const ZONES = join(MEMORY, "zones.jsonl");
export const INFERRED = join(MEMORY, "people-inferred.jsonl");
export const REPOS_INFERRED = join(MEMORY, "repos-inferred.jsonl");
export const ACTIONS = join(MEMORY, "actions.jsonl");
const LABELS = join(MEMORY, "labels.jsonl");
const VERDICTS = join(MEMORY, "verdicts.jsonl");
export const FILES = join(MEMORY, "files.jsonl");
export const STATEMENTS = join(MEMORY, "statements.jsonl");
export const RATINGS = join(MEMORY, "ratings.jsonl");
export const SCORES = join(MEMORY, "scores.jsonl");

/**
 * A file's complete lines (none when it is missing): a line still being appended, with no newline yet, waits for the
 * next read. Synchronous, so the source readers can show what memory/files.jsonl says of their files.
 */
export function linesOf(path: string) {
  const all = (existsSync(path) ? readFileSync(path, "utf8") : "").split("\n");
  all.pop();
  return all;
}

const rowsOf = <T>(path: string, schema: z.ZodType<T>) =>
  linesOf(path)
    .filter(Boolean)
    .map((l) => schema.parse(JSON.parse(l)));

export const readJsonl = <T>(path: string, schema: z.ZodType<T>) =>
  Promise.resolve(rowsOf(path, schema));

/** Appends validated rows, one per line. */
export async function appendJsonl<T>(
  path: string,
  schema: z.ZodType<T>,
  rows: T[]
) {
  if (rows.length > 0) {
    await mkdir(join(path, ".."), { recursive: true });
    await appendFile(
      path,
      rows.map((r) => `${JSON.stringify(schema.parse(r))}\n`).join("")
    );
  }
}

/** The files of a folder with that extension, by name (observations/: one `.jsonl` per month). */
export const filesIn = async (dir: string, ext = ".jsonl") =>
  (await readdir(dir).catch(() => [] as string[]))
    .filter((n) => n.endsWith(ext))
    .sort();

/** Every `.jsonl` file of a folder, by name. */
const readFolder = async <T>(dir: string, schema: z.ZodType<T>) => {
  const files = await filesIn(dir);
  return (
    await Promise.all(files.map((n) => readJsonl(join(dir, n), schema)))
  ).flat();
};

/** Every unit in memory/units/, oldest day first. */
export const readUnits = () => readFolder(UNITS, Unit);

export const readObservations = () => readFolder(OBSERVATIONS, Observation);

/** Every moment line in memory/moments/, oldest day first. */
export const readMoments = () => readFolder(MOMENTS, Moment);

/** The first and last day a moment covers: its start (else the day that read it) to its end (else its start). */
export const daysOf = (m: Moment) =>
  [
    (m.start ?? m.day).slice(0, 10),
    (m.end ?? m.start ?? m.day).slice(0, 10),
  ] as const;

/** Each moment as it stands: its line from the latest day that read it, with the units (and copies) of every day's line, in day order; never one the owner said is wrong or unimportant (a moment is on no page: any such correction hides it). */
export const momentsNow = (lines: Moment[], corrections: Correction[]) =>
  [...Map.groupBy(lines, (m) => m.id).values()].flatMap((ls) => {
    const m = ls.at(-1) as Moment;
    const all = (k: "copies" | "units") => [
      ...new Set(ls.flatMap((l) => l[k])),
    ];
    return hiding(corrections, m.id).length > 0
      ? []
      : [{ ...m, copies: all("copies"), units: all("units") }];
  });

/** Each unit's latest extraction: its last line in extracted.jsonl. */
export const latestExtractions = (ledger: Extracted[]) =>
  new Map(ledger.map((e) => [e.unit, e]));

/** The units an observation can stand on: in memory/units and not dropped by a code rule. */
export const liveUnits = (units: Unit[]) =>
  new Set(units.flatMap((u) => (u.drop ? [] : [u.id])));

/**
 * True when `o`'s unit is live and `o` comes from that unit's latest extraction (its last line in extracted.jsonl), or
 * the unit has none: a unit read again, under another content hash or another prompt version, leaves its older facts
 * in the ledger, replaced; a unit gone (a lifelog chapter re-cut) or dropped (a code rule) leaves them all.
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

/**
 * Observations a newer one replaced (memory/supersessions.jsonl): id -> the first replacement recorded whose newer
 * observation is still current (a replacement re-read away no longer retires anything).
 */
export const retiredBy = (list: Supersession[], current: Set<string>) => {
  const out = new Map<string, Supersession>();
  for (const s of list) {
    if (current.has(s.by) && !out.has(s.observation)) {
      out.set(s.observation, s);
    }
  }
  return out;
};

/** The owner's answers on the check page: the latest for each claim (null: taken back). */
export const latestRatings = (list: Rating[]) =>
  new Map(list.map((r) => [r.claim, r]));

export const readRatings = async () =>
  latestRatings(await readJsonl(RATINGS, Rating));

/** The claims his latest answer calls false, as `wrong` corrections: an undo or a later answer lifts one. */
export const ratedFalse = (latest: Map<string, Rating>): Correction[] =>
  [...latest.values()]
    .filter((r) => r.answer === "false")
    .map(({ at, claim }) => ({
      at,
      kind: "wrong",
      note: "rated false",
      observations: [claim],
      schemaVersion: 1,
    }));

/** What the owner said: memory/corrections.jsonl, then the claims he rated false on the check page (`ratedFalse`). */
export async function readCorrections(): Promise<Correction[]> {
  const [said, ratings] = await Promise.all([
    readJsonl(CORRECTIONS, Correction),
    readRatings(),
  ]);
  return [...said, ...ratedFalse(ratings)];
}

/** The ledgers that decide where an observation stands: the owner's corrections, each unit's latest extraction, the supersessions. */
export interface Standing {
  corrections: Correction[];
  latest: Map<string, Extracted>;
  live: Set<string>;
  retired: Map<string, Supersession>;
}

/** The extraction, unit and supersession ledgers, with the corrections (and the observations) the caller already holds. */
export async function readStanding(
  corrections: Correction[],
  read: Observation[] | Promise<Observation[]> = readObservations()
): Promise<Standing> {
  const [extracted, supersessions, units, observations] = await Promise.all([
    readJsonl(EXTRACTED, Extracted),
    readJsonl(SUPERSESSIONS, Supersession),
    readUnits(),
    read,
  ]);
  const c = { latest: latestExtractions(extracted), live: liveUnits(units) };
  const current = new Set(
    observations.flatMap((o) => (isCurrent(c, o) ? [o.id] : []))
  );
  return { corrections, ...c, retired: retiredBy(supersessions, current) };
}

/** A correction that hides observations (`wrong`, `not-important`): everywhere, or on its `page` only. */
export const hides = (c: Correction) =>
  c.kind === "wrong" || c.kind === "not-important" ? c : null;

/** The owner's corrections hiding `id`: everywhere (no page), or on a page. */
export const hiding = (corrections: Correction[], id: string) =>
  corrections.flatMap((c) => {
    const h = hides(c);
    return h?.observations.includes(id) ? [h] : [];
  });

/**
 * Where an observation stands: the one rule the index, the pages and the dashboard go by. First match wins: `hidden`
 * (the owner said wrong or not important, everywhere), `gone` (its unit no longer exists or a code rule drops it now),
 * `replaced` (its unit was read again and the newer extraction counts), `retired` (a newer observation superseded it: still indexed, with `by`, and still cited on a page, never new
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
  const correction = Correction.parse({
    at: new Date().toISOString(),
    schemaVersion: 1,
    ...(said as object),
  });
  await appendJsonl(CORRECTIONS, Correction, [correction]);
  return correction;
}

/** The truth benchmark: every statement, in the order it was drawn. */
export const readStatements = () => readJsonl(STATEMENTS, Statement);

/** Appends the owner's answer to one statement's claim (the check page); null takes his last one back. */
export const recordRating = (claim: string, answer: Rating["answer"]) =>
  appendJsonl(RATINGS, Rating, [
    { answer, at: new Date().toISOString(), claim, schemaVersion: 1 },
  ]);

export const readUnresolved = () => readJsonl(UNRESOLVED, Unresolved);

export const readActions = () => readJsonl(ACTIONS, Action);

export const readInferred = () => readJsonl(INFERRED, InferredPerson);

/** Life's repo guesses: the latest record for each repo wins. */
export async function readRepoGuesses() {
  const guesses = await readJsonl(REPOS_INFERRED, RepoGuess);
  return [...new Map(guesses.map((g) => [g.repo, g])).values()];
}

/** The owner's labels: the latest one for each unit wins. */
export async function readLabels() {
  const latest = new Map<string, MemoryLabel>();
  for (const l of await readJsonl(LABELS, MemoryLabel)) {
    latest.set(l.unitId, l);
  }
  return [...latest.values()];
}

/** What Life read off each file a message carried: the latest line for each ref wins. */
export const readFiles = () =>
  new Map(rowsOf(FILES, FileEntry).map((e) => [e.ref, e]));

/** Verdicts by unit and content: the latest line for each (unit, hash) wins. */
export type Verdicts = Map<string, Verdict>;
export const verdictKey = (unit: string, hash: string) => `${unit}|${hash}`;

export async function readVerdicts(): Promise<Verdicts> {
  const out: Verdicts = new Map();
  for (const v of await readJsonl(VERDICTS, Verdict)) {
    out.set(verdictKey(v.unit, v.hash), v);
  }
  return out;
}

export const appendVerdicts = (list: Verdict[]) =>
  appendJsonl(VERDICTS, Verdict, list);

/**
 * The one way to ask what the verdicts made of a unit: the verdict on its current content, or undefined when it has none
 * (not judged yet, judged on older content, or dropped by a code rule).
 */
export const verdictOf = (verdicts: Verdicts, u: Unit) =>
  u.drop ? undefined : verdicts.get(verdictKey(u.id, u.hash));
