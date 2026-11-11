import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readAppended } from "../core/files";
import type { SourceName } from "../core/names";
import { Published } from "../records/publication";
import type { Recorded } from "../sources/lifelog-recorded";
import { PUBLICATIONS, UNITS } from "./ledger";
import { enabledSources } from "./sources";
import { dayNow, dayRange, localDate } from "./zones";

// Coverage (docs/glossary.md): whether a source that captures on its own (`capturesOnItsOwn`) was captured on a local
// day. A day is captured only when something says so: a unit of the source that day, or a publication of units that
// read the source for that day (memory/publications.jsonl, appended by `publishUnits`). Absence is never read as quiet:
// it is "not seen" when Life knows it did not look, "unknown" when it cannot tell. Nothing is stored per day.

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
  /** The pendant with no unit that day: what lifelog says of its recording (`recordingOf`). */
  recording?: Verdict;
}

/**
 * The pendant on a day Life holds nothing of, from what lifelog says it recorded over a range holding the day (null:
 * it could not be asked): a stretch in the day is capture, with or without speech; none since lifelog can tell is the pendant off or out of reach; before
 * that, or unasked, nobody can tell.
 */
export function recordingOf(recorded: Recorded | null, day: string): Verdict {
  const { from = "", to } = dayRange(day, day);
  if (recorded?.stretches.some((s) => s.endAt > from && s.startAt < to)) {
    return { state: "captured" };
  }
  const since = recorded?.since && localDate(recorded.since);
  if (since && day >= since) {
    return { state: "not_seen", why: "the pendant recorded nothing this day" };
  }
  return {
    state: "unknown",
    why: recorded
      ? `nothing held; lifelog cannot tell whether it was recording before ${since || "now"}`
      : "nothing held; lifelog could not be asked whether it was recording",
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
  if (s.recording) {
    return s.recording;
  }
  return day === today ? { state: "captured" } : undefined;
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
 * capture; before the source's first day, not seen; the pendant with nothing held is what lifelog says it
 * recorded (`recordingOf`); today, a readable source is being captured; a day
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

/**
 * The coverage of `day`: each source he turned on that captures on its own, from the index (its units that day, its
 * first unit), its own first day, the day's units file, the record of what was read and, for the pendant, what lifelog
 * recorded that day (`readRecorded`; null when it could not be asked).
 */
export function readCoverage(
  db: Database,
  day: string,
  recorded: Recorded | null
): SourceDay[] {
  const withUnit = new Set(
    db
      .query<{ source: string }, [string]>(
        "select distinct source from units where date = ?"
      )
      .all(day)
      .map((r) => r.source)
  );
  const firstUnit = db.query<{ first: string | null }, [string]>(
    "select min(date) as first from units where source = ?"
  );
  const today = dayNow();
  return coverageOf(day, {
    isPublished: existsSync(join(UNITS, `${day}.jsonl`)),
    lines: readPublished(),
    sources: enabledSources()
      .filter((s) => s.capturesOnItsOwn)
      .map((s) => {
        const earliest = s.earliest?.();
        return {
          firstDay:
            (earliest ? localDate(earliest) : undefined) ??
            firstUnit.get(s.name)?.first ??
            undefined,
          hasUnit: withUnit.has(s.name),
          label: s.label,
          missing: day === today ? s.missing?.() : undefined,
          name: s.name,
          recording:
            s.kind === "voice" ? recordingOf(recorded, day) : undefined,
        };
      }),
    today,
  });
}
