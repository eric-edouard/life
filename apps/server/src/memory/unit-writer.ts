import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { clock, daysBefore } from "../core/clock";
import { appendJsonl } from "../core/files";
import type { SourceName } from "../core/names";
import { Published } from "../records/publication";
import { Unit } from "../records/unit";
import type { Store } from "../sources/voice-server";
import { type Evidence, voiceUnits } from "./gather";
import { PUBLICATIONS, readUnitsOf, UNITS } from "./memory-files";
import { preparePassages } from "./passages";
import { loadTruth } from "./read-truth";
import { kindOf } from "./sources";
import { applyRules, isFrozen } from "./units";

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
  // What was read, for whoever asks later whether a day was seen (`coverage.ts`): the days and the sources, no content.
  appendJsonl(PUBLICATIONS, Published, [
    {
      at: clock().toISOString(),
      from: evidence.window.from,
      schemaVersion: 1,
      sources: Object.keys(evidence.read) as SourceName[],
      to: evidence.window.to,
    },
  ]);
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

/** What today's write keeps as it is: lifelog's units, and those of a source not read now (off, unreadable or failed). */
function keptToday(read: string[], failed: string[]) {
  const fresh = new Set(read.filter((name) => !failed.includes(name)));
  return (u: Unit) => !fresh.has(u.source);
}

/**
 * Writes today's units from every source but lifelog (under the lock), from the evidence of `gather(today, people, {
 * files: false, log: quietly, voice: false })`: no model call; a file sent today is described on arrival by the watcher
 * (`describeFilesOnArrival`), so a later tick writes its unit with the description.
 * Today's file keeps lifelog's units and those of a source not read; a source that throws is logged by the read and keeps
 * its units. The passages are prepared only when a unit changed.
 * ponytail: reads today from every source every few minutes, a per-source cursor (`incoming`) if that ever costs; the
 * `duplicate` rule sees today only (the night's sees 7 days), the night settles it.
 */
export async function publishTodayUnits(
  evidence: Pick<Evidence, "built" | "events" | "failed" | "read" | "window">
) {
  const day = evidence.window.from;
  const kept = keptToday(Object.keys(evidence.read), evidence.failed);
  const want = evidence.built.map((b) => Unit.parse(b.unit));
  const diff = diffUnits(
    readUnitsOf([day]).filter((u) => !kept(u)),
    want
  );
  if (diff.dates.length > 0) {
    preparePassages(evidence.events, evidence.window, evidence.failed)();
    await writeUnits([day], want, kept);
  }
  return diff;
}
