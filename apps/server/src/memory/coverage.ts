import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readAppended } from "../core/files";
import type { SourceName } from "../core/names";
import { Published } from "../records/publication";
import { COVERAGE, UNITS } from "./ledger";
import { enabledSources } from "./sources";
import { dayNow, localDate } from "./zones";

// Coverage (docs/glossary.md): whether a source that captures on its own (`capturesOnItsOwn`) was captured on a local
// day. A day is captured only when something says so: a unit of the source that day, or a publication of units that
// read the source for that day (memory/coverage.jsonl, appended by `publishUnits`). Absence is never read as quiet:
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

/** What is known of one source when a day is judged. */
interface Known {
  /** Its first day: before it, nothing of it exists. */
  firstDay?: string;
  /** Whether it has a unit on the day. */
  hasUnit: boolean;
  /** The pendant: reading its store says nothing of whether it was recording. */
  isVoice: boolean;
  label: string;
  /** What keeps it from being read now, if anything. */
  missing?: string;
  name: SourceName;
}

type Verdict = Pick<SourceDay, "state" | "why">;

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
  if (s.isVoice) {
    return {
      state: "unknown",
      why: "nothing held; Life cannot tell yet whether it was recording",
    };
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
 * capture; before the source's first day, not seen; the pendant with nothing held is unknown (ponytail: until lifelog
 * can say when it recorded, a `GET /recorded` on its contract); today, a readable source is being captured; a day
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
    COVERAGE,
    Published,
    (last?: Published[]) => [...(last ?? [])],
    (all, line) => {
      all.push(line);
    }
  );

/**
 * The coverage of `day`: each source he turned on that captures on its own, from the index (its units that day, its
 * first unit), its own first day, the day's units file and the record of what was read.
 */
export function readCoverage(db: Database, day: string): SourceDay[] {
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
          isVoice: s.kind === "voice",
          label: s.label,
          missing: day === today ? s.missing?.() : undefined,
          name: s.name,
        };
      }),
    today,
  });
}
