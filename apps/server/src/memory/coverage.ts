import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { daysBefore } from "../core/clock";
import { readAppended } from "../core/files";
import type { SourceName } from "../core/names";
import { Published } from "../records/publication";
import { PUBLICATIONS, UNITS } from "./memory-files";
import { type RecordedDays, readRecordedDays } from "./recorded-days";
import { enabledSources } from "./sources";
import { dayNow, localDate } from "./zones";

// Coverage (docs/glossary.md): whether a source that captures on its own (`capturesOnItsOwn`) was captured on a local
// day. A day is captured only when something says so: a unit of the source that day, or a publication of units that
// read the source for that day (memory/publications.jsonl, appended by `publishUnits`). Absence is never read as quiet:
// it is "not seen" when Life knows it did not look, "unknown" when it cannot tell. Nothing is stored per day. Read
// over a range of days (`readCoverage`): a day is a range of one.

export type Covered = "captured" | "not_seen" | "unknown";
/** One capturing source on one day. */
export interface SourceDay {
  label: string;
  name: SourceName;
  state: Covered;
  /** Why it is not captured, in words a reader can repeat. */
  why?: string;
}

type Verdict = Pick<SourceDay, "state" | "why">;

/** What is known of one source when a day is judged. */
interface Known {
  /** Its first day: before it, nothing of it exists. */
  firstDay?: string;
  /** Whether it has a unit on the day. */
  hasUnit: boolean;
  label: string;
  /** What keeps it from being read now, if anything. */
  missing?: string;
  name: SourceName;
  /** The pendant only: the days lifelog says it recorded on (null: it was never asked), read on a day with no unit. */
  recorded?: RecordedDays | null;
}

/**
 * The pendant on a past day Life holds nothing of, from the recorded days (null: lifelog was never asked): a day
 * recorded on is capture, with or without speech; before lifelog can tell, or from the day it was last asked on
 * (whose later hours it has not said), nobody can tell; any other day is the pendant off or out of reach.
 */
export function recordingOf(kept: RecordedDays | null, day: string): Verdict {
  if (!kept) {
    return {
      state: "unknown",
      why: "nothing held; lifelog was never asked whether it was recording",
    };
  }
  if (kept.days.includes(day)) {
    return { state: "captured" };
  }
  const since = kept.since && localDate(kept.since);
  if (!since || day < since) {
    return {
      state: "unknown",
      why: `nothing held; lifelog cannot tell whether it was recording before ${since || "now"}`,
    };
  }
  const asked = localDate(kept.built);
  return day < asked
    ? { state: "not_seen", why: "the pendant recorded nothing this day" }
    : {
        state: "unknown",
        why: `nothing held; lifelog was last asked on ${asked}`,
      };
}

/** What the source itself says of the day, whatever was read: nothing when only the record can tell. */
function bySource(s: Known, day: string, today: string): Verdict | undefined {
  if (day === today && s.missing) {
    return { state: "not_seen", why: `can't be read now: ${s.missing}` };
  }
  if (s.hasUnit) {
    return { state: "captured" };
  }
  if (s.firstDay && day < s.firstDay) {
    return { state: "not_seen", why: `before its first day, ${s.firstDay}` };
  }
  if (day === today) {
    return { state: "captured" };
  }
  return s.recorded === undefined ? undefined : recordingOf(s.recorded, day);
}

/** What the record of publications says of a source on a past day it holds no unit on. */
function byRecord(
  name: SourceName,
  day: string,
  o: { isPublished: boolean; lines: Published[] }
): Verdict {
  if (!o.isPublished) {
    return { state: "not_seen", why: "Life read nothing this day" };
  }
  const covering = o.lines.filter((l) => l.from <= day && day <= l.to);
  if (covering.some((l) => l.sources.includes(name))) {
    return { state: "captured" };
  }
  if (covering.length > 0) {
    return { state: "not_seen", why: "Life did not read it this day" };
  }
  const [first] = o.lines;
  const recordFrom = first && localDate(first.at);
  return recordFrom && day >= recordFrom
    ? { state: "not_seen", why: "Life read nothing this day" }
    : {
        state: "unknown",
        why: `Life kept no record of what it read before ${recordFrom ?? "now"}`,
      };
}

/**
 * Each capturing source on `day`. In order: a source that can't be read today is not seen; a unit that day is
 * capture; before the source's first day, not seen; today, a readable source is being captured; the pendant with
 * nothing held is what lifelog said it recorded (`recordingOf`); a day
 * with no units file was never read (the history could not date it); then the record decides: a publication that read
 * the source for the day is capture, one that covers the day without it is not seen, and a day no publication covers
 * is not seen once the record exists and unknown before it.
 * ponytail: an archive stopped for over a week while nights run reads as captured (the archived source's `missing()`
 * should say so), and a bridge logged out has no signal anywhere yet.
 */
export function coverageOf(
  day: string,
  o: {
    isPublished: boolean;
    lines: Published[];
    sources: Known[];
    today: string;
  }
): SourceDay[] {
  return o.sources.map((s) => ({
    label: s.label,
    name: s.name,
    ...(bySource(s, day, o.today) ?? byRecord(s.name, day, o)),
  }));
}

const readPublished = () =>
  readAppended(
    PUBLICATIONS,
    Published,
    (last?: Published[]) => [...(last ?? [])],
    (all, line) => {
      all.push(line);
    }
  );

/** A capturing source and its first day: before it, nothing of it exists. */
export type Capturing = Pick<Known, "firstDay" | "label" | "name">;

/**
 * The coverage of each local day of `[from, to]`: each source he turned on that captures on its own, from the index
 * (its units of those days, its first unit), its own first day, the days' units files, the record of what was read
 * and, for the pendant, the recorded days (`readRecordedDays`). With the sources and their first days. What does not
 * depend on the day is read once.
 */
export function readCoverage(
  db: Database,
  from: string,
  to: string
): { days: Map<string, SourceDay[]>; sources: Capturing[] } {
  const held = new Set(
    db
      .query<{ date: string; source: string }, [string, string]>(
        "select distinct date, source from units where date between ? and ?"
      )
      .all(from, to)
      .map((r) => `${r.date} ${r.source}`)
  );
  const firstUnit = db.query<{ first: string | null }, [string]>(
    "select min(date) as first from units where source = ?"
  );
  const today = dayNow();
  const published = new Set(existsSync(UNITS) ? readdirSync(UNITS) : []);
  const lines = readPublished();
  const recorded = readRecordedDays();
  const sources = enabledSources()
    .filter((s) => s.capturesOnItsOwn)
    .map((s) => {
      // A source that can't be read can't say its first day: the index's first unit of it stands.
      const missing = s.missing?.();
      const earliest = missing ? undefined : s.earliest?.();
      return {
        firstDay:
          (earliest ? localDate(earliest) : undefined) ??
          firstUnit.get(s.name)?.first ??
          undefined,
        label: s.label,
        missing,
        name: s.name,
        recorded: s.kind === "voice" ? recorded : undefined,
      };
    });
  const days = new Map<string, SourceDay[]>();
  for (let day = from; day <= to; day = daysBefore(day, -1)) {
    days.set(
      day,
      coverageOf(day, {
        isPublished: published.has(`${day}.jsonl`),
        lines,
        sources: sources.map((s) => ({
          ...s,
          hasUnit: held.has(`${day} ${s.name}`),
        })),
        today,
      })
    );
  }
  return { days, sources };
}

type Missed = Record<Exclude<Covered, "captured">, Map<SourceName, number>>;

/**
 * By month, the days each of `sources` was not captured, as coverage answered them (`days`): not seen, or unknown.
 * Days before a source's first day (coverage's `firstDay`, never judged again here) are left out: a reader says each
 * first day once.
 */
export function notCapturedOf(
  days: Map<string, SourceDay[]>,
  sources: Capturing[]
) {
  const first = new Map(sources.map((s) => [s.name, s.firstDay ?? ""]));
  const months = new Map<string, Missed>();
  for (const [day, covered] of days) {
    for (const c of covered) {
      const from = first.get(c.name);
      if (c.state === "captured" || from === undefined || day < from) {
        continue;
      }
      const month = day.slice(0, 7);
      const missed = months.get(month) ?? {
        not_seen: new Map(),
        unknown: new Map(),
      };
      months.set(month, missed);
      missed[c.state].set(c.name, (missed[c.state].get(c.name) ?? 0) + 1);
    }
  }
  return months;
}
