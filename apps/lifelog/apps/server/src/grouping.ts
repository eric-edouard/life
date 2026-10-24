// Grouping on the server (rebuild P4), ported from the phone's old Segmentation.swift, run per
// source from the timeline facts the phone sends (PUT /sources/{id}/timeline), the words, Mac
// dictation, location moves and owner edits. Forward-only: a change marks its range dirty on the
// source, and a run regroups from the last boundary before it to the first closed conversation
// after it; a conversation 5 minutes behind heard-through is closed. Cases:
// apps/server/fixtures/segmentation/*.json. Reasoning: docs/timeline.md.

import type { Db } from "@lifelog/db";
import {
  conversations,
  holdsTurn,
  isPendant,
  transcriptionJobs as jobs,
  locationHistory,
  ownerEdits,
  quietRanges,
  sources,
  timelineSpans,
  touchesJob,
  turns,
} from "@lifelog/db/schema";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { logChange, logPlacedIn } from "./change-log";
import { uuidOf } from "./config";
import { record } from "./events";
import { distanceM } from "./places";

// Epoch milliseconds, [start, end).
export type Range = [number, number];

// The phone's old SegmentationPolicy, plus the cap. Tune here; a deploy applies it forward.
const POLICY = {
  anchorToleranceMs: 2000,
  // A conversation longer than this with no boundary is cut at its longest pause (latency).
  capMs: 60 * 60_000,
  // Closed once heard-through is this far past its end.
  closeAfterMs: 5 * 60_000,
  fixWindowMs: 10 * 60_000,
  maxFixAccuracyM: 100,
  movedGapMs: 2 * 60_000,
  moveMeters: 500,
  noSpeechGapMs: 5 * 60_000,
  quietGapMs: 45_000,
};

export interface Fix {
  accuracyM: number;
  at: number;
  latitude: number;
  longitude: number;
}

// Applied in edited order. `ai` splits go first, so the owner's merge undoes one for good.
export type Edit =
  | { kind: "split"; at: number; ai?: boolean }
  | { kind: "merge"; from: number; to: number };

export interface GroupingInput {
  audible: Range[];
  // Mac dictation: not conversation, taken out of speech and words.
  dictation: Range[];
  edits: Edit[];
  locations: Fix[];
  pauses: number[];
  // Anchors of the live conversations already known here, so ids survive; a group claims one of
  // them before a retired one's (`retired`), so a merge or undo never brings back an id it took out.
  previous: number[];
  retired?: number[];
  // Continuous capture spans in time order; a break of unknown audio (missing or untimed pages)
  // makes the time since the previous span possible speech.
  spans: { breaks: string[]; end: number; start: number }[];
  // As Segmentation counts them: `speech(orUncertain: true)`, `audible`, `unanalyzed(spans)`.
  speech: Range[];
  unanalyzed: Range[];
  // Transcribed words: speech, so a boundary never falls inside one.
  words: Range[];
}

interface Grouped {
  anchor: number;
  end: number;
  // Possible speech inside it, sorted.
  ranges: Range[];
  start: number;
}

// ---- Intervals -------------------------------------------------------------

function union(ranges: Range[]): Range[] {
  const out: Range[] = [];
  for (const [a, b] of [...ranges].sort((x, y) => x[0] - y[0])) {
    if (a >= b) {
      continue;
    }
    const last = out.at(-1);
    if (last && a <= last[1]) {
      last[1] = Math.max(last[1], b);
    } else {
      out.push([a, b]);
    }
  }
  return out;
}

// `ranges` minus `cut`, both read as unions.
function subtract(ranges: Range[], cut: Range[]): Range[] {
  const out: Range[] = [];
  const minus = union(cut);
  for (const [a, b] of union(ranges)) {
    let cursor = a;
    for (const [c, d] of minus) {
      if (d <= cursor || c >= b) {
        continue;
      }
      if (c > cursor) {
        out.push([cursor, c]);
      }
      cursor = Math.max(cursor, d);
    }
    if (cursor < b) {
      out.push([cursor, b]);
    }
  }
  return out;
}

// ---- Segmentation ----------------------------------------------------------

const UNKNOWN_BREAKS = new Set(["missingPages", "untimedPage"]);

function activeAudio(input: GroupingInput): Range[] {
  const unknownGaps: Range[] = [];
  input.spans.forEach((span, i) => {
    const before = input.spans[i - 1];
    if (before && span.breaks.some((b) => UNKNOWN_BREAKS.has(b))) {
      unknownGaps.push([before.end, Math.max(before.end, span.start)]);
    }
  });
  const spoken = subtract([...input.speech, ...input.words], input.dictation);
  return union([...spoken, ...input.unanalyzed, ...unknownGaps]);
}

// Good fixes on both sides further apart than their combined error plus `moveMeters`.
function moved([from, to]: Range, locations: Fix[]) {
  const usable = locations.filter((f) => f.accuracyM <= POLICY.maxFixAccuracyM);
  const before = usable
    .filter((f) => f.at <= from && from - f.at <= POLICY.fixWindowMs)
    .reduce<Fix | null>((m, f) => (m && m.at >= f.at ? m : f), null);
  const after = usable
    .filter((f) => f.at >= to && f.at - to <= POLICY.fixWindowMs)
    .reduce<Fix | null>((m, f) => (m && m.at <= f.at ? m : f), null);
  return (
    before !== null &&
    after !== null &&
    distanceM(before, after) - before.accuracyM - after.accuracyM >=
      POLICY.moveMeters
  );
}

function isBoundary(gap: Range, input: GroupingInput, audible: Range[]) {
  const [from, to] = gap;
  if (input.pauses.some((p) => from <= p && p <= to)) {
    return true;
  }
  if (to - from >= POLICY.noSpeechGapMs) {
    return true;
  }
  if (subtract([gap], audible).some(([a, b]) => b - a >= POLICY.quietGapMs)) {
    return true;
  }
  return to - from >= POLICY.movedGapMs && moved(gap, input.locations);
}

// The stretches between consecutive ranges.
const gapsOf = (ranges: Range[]): Range[] =>
  ranges.slice(1).map(([start], i) => [ranges[i]?.[1] ?? start, start]);
const middle = ([a, b]: Range) => a + Math.floor((b - a) / 2);

// Possible speech cut at each boundary, grouped between them.
function groupsAt(active: Range[], boundaries: number[]) {
  const slot = (at: number) => {
    const i = boundaries.findIndex((b) => at < b);
    return i === -1 ? boundaries.length : i;
  };
  const groups: Range[][] = [...boundaries, 0].map(() => []);
  for (const [a, b] of active) {
    let cursor = a;
    for (const boundary of boundaries) {
      if (cursor < boundary && boundary < b) {
        groups[slot(cursor)]?.push([cursor, boundary]);
        cursor = boundary;
      }
    }
    groups[slot(cursor)]?.push([cursor, b]);
  }
  return groups.flatMap((ranges) => {
    const [first] = ranges;
    const last = ranges.at(-1);
    return first && last ? [{ end: last[1], ranges, start: first[0] }] : [];
  });
}

// Pure and deterministic. `capSplits` are the cuts the 60-minute cap made this time; the caller
// keeps them as AI splits so the next run makes the same ones.
export function segment(input: GroupingInput) {
  const active = activeAudio(input);
  const audible = union(input.audible);
  let boundaries = gapsOf(active)
    .filter((gap) => isBoundary(gap, input, audible))
    .map(middle);
  for (const edit of input.edits) {
    if (edit.kind === "split" && edit.ai) {
      boundaries.push(edit.at);
    }
  }
  const merges: Range[] = [];
  for (const edit of input.edits) {
    if (edit.kind === "split" && !edit.ai) {
      boundaries.push(edit.at);
    } else if (edit.kind === "merge") {
      merges.push([edit.from, edit.to]);
      boundaries = boundaries.filter((b) => !(edit.from < b && b < edit.to));
    }
  }
  boundaries.sort((a, b) => a - b);

  // The cap: a group over an hour with no owner merge in it is cut at its longest pause.
  const capSplits: number[] = [];
  let groups = groupsAt(active, boundaries);
  for (;;) {
    const cut = groups
      .filter(
        (g) =>
          g.end - g.start > POLICY.capMs &&
          !merges.some(([a, b]) => a < g.end && g.start < b)
      )
      .map((g) => longestPause(g.ranges))
      .find((at) => at !== null);
    if (cut === undefined || cut === null) {
      break;
    }
    capSplits.push(cut);
    boundaries = [...boundaries, cut].sort((a, b) => a - b);
    groups = groupsAt(active, boundaries);
  }

  const unclaimed = [input.previous, input.retired ?? []].map((anchors) =>
    [...anchors].sort((a, b) => a - b)
  );
  const claim = (g: { end: number; start: number }) => {
    for (const anchors of unclaimed) {
      const i = anchors.findIndex(
        (a) => g.start - POLICY.anchorToleranceMs <= a && a < g.end
      );
      if (i !== -1) {
        return anchors.splice(i, 1)[0];
      }
    }
  };
  const grouped = groups.map(
    (g): Grouped => ({ ...g, anchor: claim(g) ?? g.start })
  );
  return { capSplits, conversations: grouped };
}

// The middle of the longest stretch between two pieces of possible speech; null when none.
function longestPause(ranges: Range[]) {
  const gaps = gapsOf(ranges).filter(([a, b]) => b > a);
  const longest = gaps.reduce<Range | null>(
    (m, g) => (m && m[1] - m[0] >= g[1] - g[0] ? m : g),
    null
  );
  return longest && middle(longest);
}

// ---- Ids ---------------------------------------------------------------------

// The phone's `ConversationID.serverID`: the anchor's milliseconds in the last 48 bits of an
// otherwise zero UUID, version and variant 8 (docs/formats.md).
export const anchorId = (anchor: number) =>
  `00000000-0000-8000-8000-${anchor.toString(16).padStart(12, "0")}`;

const ANCHOR_ID = /^00000000-0000-8000-8000-([0-9a-f]{12})$/;
export function anchorOf(id: string) {
  const hex = ANCHOR_ID.exec(id)?.[1];
  return hex === undefined ? null : Number.parseInt(hex, 16);
}

// ---- Per source, in the database ---------------------------------------------

const ms = (d: Date) => d.getTime();
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// An AI split's id comes from its instant alone (the cap's and a summary's alike): made again, it
// is the same row, and an owner's undo of it stays.
export const aiSplitId = (at: number) => uuidOf(`ai-split|${at}`);

// Records that `range` (epoch ms or Dates) changed for these sources, last in the writer's
// transaction: the next regroup covers it, and a regroup that failed leaves it for the tick
// (`regroupDirty`). Two changes merge into the range over both. Transactions run one at a time, so
// a regroup never clears a change it didn't see.
export function markDirty(
  tx: Pick<Db, "update">,
  sourceIds: string[],
  [from, to]: [Date | number, Date | number]
) {
  if (sourceIds.length === 0) {
    return;
  }
  const [a, b] = [new Date(from).getTime(), new Date(to).getTime()];
  tx.update(sources)
    .set({
      dirtyFrom: sql`min(coalesce(${sources.dirtyFrom}, ${a}), ${a})`,
      dirtyTo: sql`max(coalesce(${sources.dirtyTo}, ${b}), ${b})`,
    })
    .where(inArray(sources.id, sourceIds))
    .run();
}

// Where a run starts so the change at `from` is regrouped and nothing before it moves: just
// before the last conversation starting at or before it, unless the change is too far past its
// end to join it (5 minutes without speech always splits). -Infinity: everything.
function cutBefore(tx: Tx, sourceId: string, from: number) {
  const rows = tx
    .select({
      end: conversations.captureEndedAt,
      start: conversations.captureStartedAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.sourceId, sourceId),
        isNull(conversations.retiredAt),
        lte(conversations.captureStartedAt, new Date(from))
      )
    )
    .orderBy(desc(conversations.captureStartedAt))
    .all();
  const [last] = rows;
  if (!last) {
    return Number.NEGATIVE_INFINITY;
  }
  if (from >= ms(last.end) + POLICY.noSpeechGapMs) {
    return ms(last.end);
  }
  // The one before must end before the cut, so its id stays out of reach of those after.
  let later = last;
  for (const row of rows.slice(1)) {
    const cut = ms(later.start) - POLICY.anchorToleranceMs;
    if (ms(row.end) <= cut) {
      return cut;
    }
    later = row;
  }
  return Number.NEGATIVE_INFINITY;
}

// Where a run stops so it stays forward-only: the start of the first closed conversation that
// starts after the change (`to`). It and everything after keep the policy they were grouped
// under. Infinity: the run goes to the end (only open conversations after the change).
function stopAfter(tx: Tx, sourceId: string, to: number) {
  const next = tx
    .select({ start: conversations.captureStartedAt })
    .from(conversations)
    .where(
      and(
        eq(conversations.sourceId, sourceId),
        isNull(conversations.retiredAt),
        isNotNull(conversations.closedAt),
        gt(conversations.captureStartedAt, new Date(to))
      )
    )
    .orderBy(asc(conversations.captureStartedAt))
    .limit(1)
    .get();
  return next ? ms(next.start) : Number.POSITIVE_INFINITY;
}

// Ranges clipped to [cut, stop).
const clip = (ranges: Range[], cut: number, stop: number): Range[] =>
  ranges.flatMap(([a, b]): Range[] =>
    b > cut && a < stop ? [[Math.max(a, cut), Math.min(b, stop)]] : []
  );
const toRanges = (pairs: [string, string][]): Range[] =>
  pairs.map(([a, b]) => [Date.parse(a), Date.parse(b)]);
// [start, end) columns overlapping [cut, stop); either side may be unbounded.
const overlapping = (
  start: SQLiteColumn,
  end: SQLiteColumn,
  { cut, stop }: { cut: number; stop: number }
) =>
  and(
    Number.isFinite(cut) ? gt(end, new Date(cut)) : undefined,
    Number.isFinite(stop) ? lt(start, new Date(stop)) : undefined
  );

// Edits as grouping reads them: live (not undone) splits and merges, in edited order.
function liveEdits(db: Pick<Db, "select">): Edit[] {
  const rows = db
    .select()
    .from(ownerEdits)
    .where(
      and(
        isNull(ownerEdits.undoneAt),
        inArray(ownerEdits.kind, ["split", "merge"])
      )
    )
    .orderBy(asc(ownerEdits.editedAt), asc(ownerEdits.createdAt))
    .all();
  return rows.flatMap((e): Edit[] => {
    if (e.kind === "split" && e.at) {
      return [{ ai: e.source === "ai", at: ms(e.at), kind: "split" }];
    }
    return e.kind === "merge" && e.from && e.to
      ? [{ from: ms(e.from), kind: "merge", to: ms(e.to) }]
      : [];
  });
}

const dictationRanges = (db: Pick<Db, "select">, after: number) =>
  db
    .select({ end: quietRanges.endedAt, start: quietRanges.startedAt })
    .from(quietRanges)
    .where(
      and(
        ne(quietRanges.source, "playback"),
        Number.isFinite(after)
          ? gt(quietRanges.endedAt, new Date(after))
          : undefined
      )
    )
    .all()
    .map((r): Range => [ms(r.start), ms(r.end)]);

const fixes = (db: Pick<Db, "select">, after: number) =>
  db
    .select()
    .from(locationHistory)
    .where(
      and(
        eq(locationHistory.source, "fix"),
        Number.isFinite(after)
          ? gte(
              locationHistory.observedAt,
              new Date(after - POLICY.fixWindowMs)
            )
          : undefined
      )
    )
    .all()
    .map(
      (f): Fix => ({
        accuracyM: f.accuracyM,
        at: ms(f.observedAt),
        latitude: f.latitude,
        longitude: f.longitude,
      })
    );

// What a regroup wrote, logged for the feed once nothing more is written (change-log.ts): the
// conversations, the AI splits, and the ranges of turns whose conversation changed (`turnsMoved`).
interface Written {
  conversations: string[];
  edits: string[];
  ranges: Range[];
}

// Regroups what changes marked dirty on the source (`markDirty`), closes and classifies, and logs
// what changed last. One transaction: a change marking the source meanwhile waits, then marks it
// for the next. A failure leaves it for the tick.
export function groupSource(db: Db, sourceId: string) {
  return db.transaction((tx) => {
    const source = tx
      .select()
      .from(sources)
      .where(eq(sources.id, sourceId))
      .get();
    if (!source) {
      return { changed: 0 };
    }
    const written: Written = { conversations: [], edits: [], ranges: [] };
    const { dirtyFrom, dirtyTo } = source;
    let regrouped: { cut: number; stop: number } | null = null;
    if (dirtyFrom && dirtyTo) {
      regrouped = regroup(tx, source, [ms(dirtyFrom), ms(dirtyTo)], written);
      tx.update(sources)
        .set({ dirtyFrom: null, dirtyTo: null })
        .where(eq(sources.id, sourceId))
        .run();
    }
    closeAndClassify(tx, source, regrouped, written);
    logPlacedIn(tx, written.ranges);
    logChange(tx, "edit", written.edits);
    logChange(tx, "conversation", written.conversations);
    return { changed: new Set(written.conversations).size };
  });
}

// The tick's pass: every source a change marked that no regroup covered yet.
export function regroupDirty(db: Db) {
  const dirty = db
    .select({ id: sources.id })
    .from(sources)
    .where(isNotNull(sources.dirtyFrom))
    .all();
  for (const { id } of dirty) {
    groupSource(db, id);
  }
  return dirty.length;
}

// Regroups sources once the change that marked them dirty committed: the iPhone's timeline (the
// route), a raw-page source's labels (page-processing.ts) and a job's words (jobs.ts). A failure is
// logged and recorded, and the range stays dirty for the tick.
export function regroupAfterCommit(db: Db, sourceIds: string[]) {
  for (const id of sourceIds) {
    try {
      groupSource(db, id);
    } catch (error) {
      console.error(`grouping ${id}: ${String(error)}`);
      record(db, "grouping.failed", { source: id });
    }
  }
}

// Regroups `[from, to]` from the source's timeline spans (the cutover's history among
// them), its words, Mac dictation, location moves and the edits, between the cut before it
// and the stop after it.
function regroup(
  tx: Tx,
  source: typeof sources.$inferSelect,
  [from, to]: Range,
  written: Written
) {
  const sourceId = source.id;
  const cut = cutBefore(tx, sourceId, from);
  const stop = stopAfter(tx, sourceId, to);
  const bounds = { cut, stop };
  const spans = tx
    .select()
    .from(timelineSpans)
    .where(
      and(
        eq(timelineSpans.sourceId, sourceId),
        overlapping(timelineSpans.startAt, timelineSpans.endAt, bounds)
      )
    )
    .orderBy(asc(timelineSpans.startAt))
    .all();
  if (spans.length === 0) {
    return { cut, stop };
  }
  const words = tx
    .select({ words: turns.words })
    .from(turns)
    .innerJoin(jobs, eq(jobs.id, turns.jobId))
    .where(
      and(
        eq(jobs.sourceId, sourceId),
        overlapping(turns.startAt, turns.endAt, bounds)
      )
    )
    .all();
  const facts = (key: "speech" | "audible" | "unanalyzed") =>
    clip(
      spans.flatMap((s) => toRanges(s.facts[key])),
      cut,
      stop
    );
  // Conversations between the cut and the stop, live and retired: a split brings a merged one
  // back at its id.
  const known = tx
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.sourceId, sourceId),
        ne(conversations.kind, "imported"),
        overlapping(
          conversations.captureStartedAt,
          conversations.captureEndedAt,
          bounds
        )
      )
    )
    .all()
    .filter((c) => {
      const anchor = anchorOf(c.id) ?? Number.NEGATIVE_INFINITY;
      return anchor >= cut && anchor < stop;
    });
  const anchors = (live: boolean) =>
    known.flatMap((c) =>
      (c.retiredAt === null) === live ? (anchorOf(c.id) ?? []) : []
    );
  const { capSplits, conversations: grouped } = segment({
    audible: facts("audible"),
    dictation: clip(dictationRanges(tx, cut), cut, stop),
    edits: liveEdits(tx),
    locations: fixes(tx, cut),
    pauses: spans
      .flatMap((s) => s.facts.pauses.map((p) => Date.parse(p.at)))
      .filter((p) => p >= cut && p < stop),
    previous: anchors(true),
    retired: anchors(false),
    spans: spans.map((s) => ({
      breaks: s.facts.breaks.map((b) => b.kind),
      end: Math.min(ms(s.endAt), stop),
      start: Math.max(ms(s.startAt), cut),
    })),
    speech: facts("speech"),
    unanalyzed: facts("unanalyzed"),
    words: clip(
      words.flatMap((t) => t.words.map((w): Range => [w.start, w.end])),
      cut,
      stop
    ),
  });
  if (capSplits.length > 0) {
    const kept = tx
      .insert(ownerEdits)
      .values(
        capSplits.map((at) => ({
          at: new Date(at),
          editedAt: new Date(),
          id: aiSplitId(at),
          kind: "split" as const,
          source: "ai" as const,
        }))
      )
      .onConflictDoNothing()
      .returning({ id: ownerEdits.id })
      .all();
    written.edits.push(...kept.map((e) => e.id));
  }
  write(tx, sourceId, grouped, known, written);
  return { cut, stop };
}

type Row = typeof conversations.$inferSelect;

// Upserts the grouped conversations and retires the known ones no group claimed. Only rows that
// changed are written, with the ranges they moved turns in or out of in `written`: a turn's
// conversation in the feed is never stale.
function write(
  tx: Tx,
  sourceId: string,
  grouped: Grouped[],
  known: Row[],
  written: Written
) {
  const byId = new Map(known.map((c) => [c.id, c]));
  for (const g of grouped) {
    const id = anchorId(g.anchor);
    const old = byId.get(id);
    byId.delete(id);
    if (!(old && same(old, g))) {
      upsert(tx, sourceId, id, g);
      written.conversations.push(id);
      written.ranges.push(...turnsMoved(old, g));
    }
  }
  const gone = [...byId.values()].filter((c) => c.retiredAt === null);
  for (const old of gone) {
    tx.update(conversations)
      .set({ retiredAt: new Date(), successorId: successor(old, grouped) })
      .where(eq(conversations.id, old.id))
      .run();
    written.conversations.push(old.id);
    written.ranges.push(was(old));
  }
}

const was = (c: Row): Range => [ms(c.captureStartedAt), ms(c.captureEndedAt)];

// The stretches where a new range moved turns in or out of a conversation (a turn is in the one
// its start falls in). While the start stays, only the one between the old and new end: the open
// conversation growing logs its new turns, not all of them. A moved start renumbers its voices
// (transcript.ts `speakerNames`), so then every turn of both ranges.
function turnsMoved(old: Row | undefined, g: Grouped): Range[] {
  if (!old || old.retiredAt !== null) {
    return [[g.start, g.end]];
  }
  const [start, end] = was(old);
  return start === g.start
    ? [[Math.min(end, g.end), Math.max(end, g.end)]]
    : [
        [g.start, g.end],
        [start, end],
      ];
}

const same = (old: Row, g: Grouped) =>
  old.retiredAt === null &&
  ms(old.captureStartedAt) === g.start &&
  ms(old.captureEndedAt) === g.end;

// A retired conversation comes back live, with its new range.
function upsert(tx: Tx, sourceId: string, id: string, g: Grouped) {
  const range = {
    captureEndedAt: new Date(g.end),
    captureStartedAt: new Date(g.start),
    retiredAt: null,
    successorId: null,
  };
  tx.insert(conversations)
    .values({ ...range, id, sourceId })
    .onConflictDoUpdate({ set: range, target: conversations.id })
    .run();
}

// The conversation now covering its anchor, or else its range.
function successor(old: Row, grouped: Grouped[]) {
  const anchor = anchorOf(old.id) ?? ms(old.captureStartedAt);
  const [start, end] = [ms(old.captureStartedAt), ms(old.captureEndedAt)];
  const holder =
    grouped.find((g) => g.start <= anchor && anchor < g.end) ??
    grouped.find((g) => g.start < end && start < g.end);
  return holder ? anchorId(holder.anchor) : null;
}

// Closes the source's conversations heard-through passed by 5 minutes, and sets the kind of the
// open ones and those a run regrouped (between its cut and stop): `silent` when every job over it
// is transcribed and it has no words, `dictation` when it lies inside Mac dictation, else
// `conversation`.
function closeAndClassify(
  tx: Tx,
  { heardThrough, id: sourceId }: typeof sources.$inferSelect,
  regrouped: { cut: number; stop: number } | null,
  written: Written
) {
  const bound = (finite: boolean, test: SQL) => (finite ? test : sql`true`);
  const window = regrouped
    ? sql`(${bound(
        Number.isFinite(regrouped.cut),
        sql`c.capture_ended_at > ${regrouped.cut}`
      )} and ${bound(
        Number.isFinite(regrouped.stop),
        sql`c.capture_started_at < ${regrouped.stop}`
      )})`
    : sql`false`;
  const closeBy = heardThrough ? ms(heardThrough) - POLICY.closeAfterMs : null;
  const rows = tx.all<{ id: string }>(sql`
    with live as (
      select c.* from conversations c
      where c.source_id = ${sourceId} and c.retired_at is null and c.kind <> 'imported'
        and (c.closed_at is null or ${window})),
    next as (
      select l.id,
        ${closeBy} is not null and l.capture_ended_at <= ${closeBy} as closed,
        case
          when exists (select 1 from quiet_ranges q where q.source <> 'playback'
            and q.started_at <= l.capture_started_at and q.ended_at >= l.capture_ended_at)
            then 'dictation'
          when exists (select 1 from transcription_jobs j where j.source_id = ${sourceId}
              and ${touchesJob("l")})
            and not exists (select 1 from transcription_jobs j where j.source_id = ${sourceId}
              and ${touchesJob("l")} and j.state <> 'completed')
            and not exists (select 1 from turns t join transcription_jobs j on j.id = t.job_id
              where j.source_id = ${sourceId} and ${holdsTurn("l")})
            then 'silent'
          else 'conversation'
        end as kind
      from live l)
    update conversations as c
    set kind = n.kind,
      closed_at = case when n.closed then coalesce(c.closed_at, ${Date.now()}) end
    from next n
    where c.id = n.id and (c.kind <> n.kind or (c.closed_at is not null) <> n.closed)
    returning id`);
  written.conversations.push(...rows.map((r) => r.id));
}

// ---- Owner edits ---------------------------------------------------------------

export type EditRequest = { editedAt: string; id: string } & (
  | { at: string; kind: "split" | "dismissSplit" }
  | { from: string; kind: "merge"; to: string }
  | { edit: string; kind: "undo" }
);

const date = (iso: string | undefined) => (iso ? new Date(iso) : null);

// The range an edit moves boundaries in; null for a dismissed suggestion, which groups nothing.
const editRange = (e: {
  at: Date | null;
  from: Date | null;
  kind: string;
  to: Date | null;
}): [Date, Date] | null => {
  if (e.kind === "dismissSplit") {
    return null;
  }
  const from = e.at ?? e.from;
  return from ? [from, e.to ?? from] : null;
};

interface Undoing {
  refused?: "unknown" | "undoOfUndo";
  target: typeof ownerEdits.$inferSelect | null;
}

// The edit an undo undoes: one the server has, and not an undo itself.
function undone(tx: Tx, id: string): Undoing {
  const target = tx
    .select()
    .from(ownerEdits)
    .where(eq(ownerEdits.id, id))
    .get();
  if (!target) {
    return { refused: "unknown", target: null };
  }
  return target.kind === "undo"
    ? { refused: "undoOfUndo", target: null }
    : { target };
}

// Whether a split or merge touches an imported recording (old-app audio is never regrouped, its
// pieces could not play): an instant of the edit lies in one.
function touchesImported(tx: Tx, edit: EditRequest) {
  if (edit.kind === "undo" || edit.kind === "dismissSplit") {
    return false;
  }
  const instants = edit.kind === "merge" ? [edit.from, edit.to] : [edit.at];
  const hit = tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        eq(conversations.kind, "imported"),
        isNull(conversations.retiredAt),
        or(
          ...instants.map((at) =>
            and(
              lte(conversations.captureStartedAt, new Date(at)),
              gte(conversations.captureEndedAt, new Date(at))
            )
          )
        )
      )
    )
    .limit(1)
    .get();
  return hit !== undefined;
}

// Every Pendant source: an edit is in capture time, which any of them may hold. Imported
// recordings stay as handed over.
// ponytail: one Pendant today; find the source by the edit's instant when there are several.
export const pendantSources = (db: Pick<Db, "select">) =>
  db
    .select({ id: sources.id })
    .from(sources)
    .where(isPendant)
    .all()
    .map((r) => r.id);

// Keeps an owner's edit once, by its id; an undo marks the edit it undoes. The range it moves is
// marked dirty on every Pendant source in the same transaction, so the regroup after it (or the
// tick's) always comes. Refused: an undo of an unknown edit or of an undo, and a split or merge
// inside an imported recording.
export function saveEdit(db: Db, edit: EditRequest) {
  return db.transaction((tx) => {
    if (touchesImported(tx, edit)) {
      return { refused: "imported" as const };
    }
    const undoing: Undoing =
      edit.kind === "undo" ? undone(tx, edit.edit) : { target: null };
    if (undoing.refused) {
      return { refused: undoing.refused };
    }
    const row = rowOf(edit, undoing.target?.id ?? null);
    const inserted = tx
      .insert(ownerEdits)
      .values(row)
      .onConflictDoNothing()
      .returning({ id: ownerEdits.id })
      .get();
    if (inserted) {
      applyEdit(tx, row, undoing);
    }
    return { stored: inserted !== undefined };
  });
}

// A new edit's effects: the edit it undoes marked, its range dirty, then the feed's logs.
function applyEdit(tx: Tx, row: ReturnType<typeof rowOf>, undoing: Undoing) {
  const undoneIds = row.target ? [row.target] : [];
  tx.update(ownerEdits)
    .set({ undoneAt: row.editedAt })
    .where(and(inArray(ownerEdits.id, undoneIds), isNull(ownerEdits.undoneAt)))
    .run();
  const range = editRange(undoing.target ?? row);
  if (range) {
    markDirty(tx, pendantSources(tx), range);
  }
  logChange(tx, "conversation", dismissedIn(tx, row, undoing));
  logChange(tx, "edit", [row.id, ...undoneIds]);
}

// The live conversations a dismissed suggestion (or its undo) falls in: their `splitSuggestions`
// change.
function dismissedIn(
  tx: Tx,
  row: { at: Date | null; kind: string },
  undoing: Undoing
) {
  const at = [row, undoing.target].find((e) => e?.kind === "dismissSplit")?.at;
  if (!at) {
    return [];
  }
  const holders = tx
    .select({ id: conversations.id })
    .from(conversations)
    .where(
      and(
        isNull(conversations.retiredAt),
        lte(conversations.captureStartedAt, at),
        gt(conversations.captureEndedAt, at)
      )
    )
    .all();
  return holders.map((c) => c.id);
}

function rowOf(edit: EditRequest, target: string | null) {
  const { at, from, to } = edit as Partial<
    Record<"at" | "from" | "to", string>
  >;
  return {
    at: date(at),
    editedAt: new Date(edit.editedAt),
    from: date(from),
    id: edit.id,
    kind: edit.kind,
    target,
    to: date(to),
  };
}
