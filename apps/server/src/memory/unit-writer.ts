import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { daysBefore } from "../core/clock";
import { Unit } from "../records/unit";
import type { Store } from "../sources/lifelog";
import { readFiles, readUnitsOf, UNITS } from "./ledger";
import { showFiles } from "./message-files";
import { preparePassages } from "./passages";
import { loadTruth } from "./read-truth";
import { kindOf, quietly } from "./sources";
import {
  applyRules,
  type Evidence,
  isFrozen,
  readSourceEvents,
  sourceUnitsOf,
  voiceUnits,
} from "./units";
import { readPeople } from "./who";
import { dayStart } from "./zones";

/** All local days in a window, including empty days. */
export function unitDays(window: { from: string; to: string }) {
  const days: string[] = [];
  for (let day = window.from; day <= window.to; day = daysBefore(day, -1)) {
    days.push(day);
  }
  return days;
}

/** Publishes the collected window only when every available source finished. */
export async function publishUnits(evidence: Evidence, passages?: () => void) {
  if (evidence.failed.length > 0) {
    throw new Error(`sources failed: ${evidence.failed.join(", ")}`);
  }
  for (const b of evidence.built) {
    Unit.parse(b.unit);
  }
  const publishPassages =
    passages ??
    preparePassages(evidence.events, evidence.window, evidence.skipped);
  publishPassages();
  await writeUnits(
    unitDays(evidence.window),
    evidence.built.map((b) => b.unit),
    (u) => evidence.skipped.includes(u.source) || isFrozen(u)
  );
}

/**
 * Writes memory/units/<date>.jsonl for each of `dates`: that day's units, sorted by start, with the units already there
 * that `keep` keeps (those of a source this write did not read).
 */
export async function writeUnits(
  dates: string[],
  fresh: Unit[],
  keep: (u: Unit) => boolean = () => false
) {
  const ids = new Set(fresh.map((u) => u.id));
  const units = [
    ...fresh,
    ...readUnitsOf(dates)
      .filter(keep)
      .filter((u) => !ids.has(u.id)),
  ];
  const staged = dates.map((date) => {
    const lines = units
      .filter((u) => u.date === date)
      .sort(
        (a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id)
      )
      .map((u) => JSON.stringify(Unit.parse(u)));
    return {
      path: join(UNITS, `${date}.jsonl`),
      text: `${lines.join("\n")}\n`,
    };
  });
  await mkdir(UNITS, { recursive: true });
  try {
    await Promise.all(staged.map((s) => Bun.write(`${s.path}.tmp`, s.text)));
    await Promise.all(staged.map((s) => rename(`${s.path}.tmp`, s.path)));
  } finally {
    await Promise.all(staged.map((s) => rm(`${s.path}.tmp`, { force: true })));
  }
}

/**
 * Makes the lifelog units in memory/units/ from `since` on the ones the store gives (what the watcher does after a page,
 * `since` where the page touched: `apply`); a chapter unit stays as stored while its conversation is live
 * (`frozenUnits`), and goes with it. A day's file is rewritten only when its lifelog units differ; other units in it
 * stay. Returns how many units were built, changed and removed, the units written (`written`), and whether a unit went
 * or a code rule dropped or took one back (`hasGoneOrBack`: the observations on it go or come back).
 * ponytail: `gather` (episodes) and this apply the `duplicate` rule within what they read, so a lifelog unit repeating
 * one from before may flip between the two writers; one writer settles it. A unit id that comes back (a conversation
 * regrouped onto a day it had left) counts as new: its old observations stay gone until the next full rebuild (the
 * night's); compare ids against the index's observations if that day matters.
 */
export async function syncLifelogUnits(store: Store, since: Date) {
  const { built, chapters, have } = await voiceUnits(
    store,
    since,
    await loadTruth()
  );
  const want = [
    ...chapters,
    ...applyRules(built).map((b) => Unit.parse(b.unit)),
  ];
  const diff = diffUnits(have, want);
  // Every voice unit on those days that this sync did not read stays.
  const read = new Set(have.map((u) => u.id));
  await writeUnits(
    diff.dates,
    want,
    (u) => kindOf(u.source) !== "voice" || !read.has(u.id)
  );
  return diff;
}

/**
 * What a writer changes on disk: the units it read there (`have`, only the kind it writes) against those it wants.
 * Returns how many were added, changed and removed, the units written (`written`), the days whose files change (a unit
 * that changed its day leaves the old day's file too), and whether a unit went or a code rule dropped or took one back
 * (`hasGoneOrBack`: the index is rebuilt whole, the observations on it go or come back).
 */
export function diffUnits(have: Unit[], want: Unit[]) {
  const json = (units: Unit[]) =>
    new Map(units.map((u) => [u.id, JSON.stringify(u)]));
  const [had, wants] = [json(have), json(want)];
  const added = want.filter((u) => !had.has(u.id));
  const changed = want.filter(
    (u) => had.has(u.id) && had.get(u.id) !== wants.get(u.id)
  );
  const removed = have.filter((u) => !wants.has(u.id));
  const dates = new Set(
    [...want, ...have]
      .filter((u) => had.get(u.id) !== wants.get(u.id))
      .map((u) => u.date)
  );
  const dropOf = new Map(have.map((u) => [u.id, !!u.drop]));
  return {
    added: added.length,
    changed: changed.length,
    dates: [...dates],
    hasGoneOrBack:
      removed.length > 0 || changed.some((u) => dropOf.get(u.id) !== !!u.drop),
    removed: removed.length,
    written: [...added, ...changed],
  };
}

/**
 * Today's units from every source but lifelog, built as the night builds them, with no model call: a file sent today
 * stays a tag until the night describes it. Read outside the lock (`publishTodayUnits` writes them under it). A source
 * that throws is logged and keeps its units, like one that can't be read now; the rest are built.
 * ponytail: reads today from every source every few minutes, a per-source cursor (`incoming`) if that ever costs; the
 * `duplicate` rule sees today only (the night's sees 7 days), the night settles it.
 */
export async function buildTodayUnits(day: string) {
  const { resolve, truth } = await readPeople();
  const { failed, read } = await readSourceEvents(
    dayStart(day),
    undefined,
    truth,
    quietly
  );
  const events = showFiles(
    read.flatMap((r) => r.events),
    readFiles()
  );
  const want = sourceUnitsOf(events, resolve)
    .map((b) => Unit.parse(b.unit))
    .filter((u) => u.date === day);
  return {
    day,
    kept: keptToday(
      read.map((r) => r.s.name),
      failed
    ),
    passages: preparePassages(events, { from: day, to: day }, failed),
    want,
  };
}

/** What today's write keeps as it is: lifelog's units, and those of a source not read now (off, unreadable or failed). */
export function keptToday(read: string[], failed: string[]) {
  const fresh = new Set(read.filter((name) => !failed.includes(name)));
  return (u: Unit) => !fresh.has(u.source);
}

/** Writes what `buildTodayUnits` built (under the lock): today's file keeps lifelog's units and those of a source not read. */
export async function publishTodayUnits(built: {
  day: string;
  kept: (u: Unit) => boolean;
  passages: () => void;
  want: Unit[];
}) {
  const diff = diffUnits(
    readUnitsOf([built.day]).filter((u) => !built.kept(u)),
    built.want
  );
  if (diff.dates.length > 0) {
    built.passages();
    await writeUnits([built.day], built.want, built.kept);
  }
  return diff;
}
