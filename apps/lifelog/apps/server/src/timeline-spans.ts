// Timeline spans, what grouping reads of a source's capture (grouping.ts): the iPhone sends its own
// (PUT /sources/{id}/timeline); the server writes a raw-page source's from its labels
// (page-labels.ts `spansOf`). One shape and one writer function for both.
import { z } from "@hono/zod-openapi";
import { DAY, MIN } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  holdsPages,
  isPendant,
  transcriptionJobs as jobs,
  sources,
  timelineSpans,
} from "@lifelog/db/schema";
import { and, asc, eq, gte, inArray, ne } from "drizzle-orm";
import { markDirty, overlapping } from "./grouping";
import { unioned } from "./page-rules";

export const Instant = z.iso.datetime({ offset: true });
const Interval = z
  .tuple([Instant, Instant])
  .refine(([a, b]) => Date.parse(a) <= Date.parse(b), "ends before it starts");

// One span as the phone builds it (`FactsBuilder.spans`), and as the server writes a page
// source's.
export const TimelineSpan = z
  .object({
    audible: z.array(Interval).describe("Some analyzer but Silero heard sound"),
    breaks: z
      .array(z.object({ at: Instant, kind: z.string().min(1).max(40) }))
      .describe(
        "Why this span starts apart from the one before (`missingPages`, `untimedPage`, …), at its start"
      ),
    endAt: Instant,
    firstPage: z.int().nonnegative(),
    pauses: z
      .array(z.object({ at: Instant }))
      .describe("Recording pauses the Pendant confirmed"),
    speech: z
      .array(Interval)
      .describe("Speech as segmentation counts it (uncertain audio included)"),
    startAt: Instant,
    unanalyzed: z
      .array(Interval)
      .describe("Audio no analyzer reached yet, pieces of a second or more"),
  })
  .refine((s) => Date.parse(s.startAt) <= Date.parse(s.endAt), "empty span")
  .openapi("TimelineSpan");

export type SpanFacts = z.infer<typeof TimelineSpan>;

// The jobs holding a span placed again more than 1 s off, and by how much (ms): logged as
// `job.span_moved`, their maps not moved (docs/timeline.md, "Fragments and blocks").
function movedUnderJobs(
  db: Pick<Db, "select">,
  sourceId: string,
  old: { firstPage: number; startAt: Date }[],
  spans: { firstPage: number; startAt: string }[]
) {
  const moved: { jobId: string; ms: number }[] = [];
  for (const was of old) {
    const now = spans.find((s) => s.firstPage === was.firstPage);
    const ms = now ? Date.parse(now.startAt) - was.startAt.getTime() : 0;
    if (Math.abs(ms) > 1000) {
      const held = db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.sourceId, sourceId),
            ne(jobs.state, "failed"),
            holdsPages("transcription_jobs", [[was.firstPage, was.firstPage]])
          )
        )
        .all();
      moved.push(...held.map(({ id }) => ({ jobId: id, ms })));
    }
  }
  return moved;
}

// Stores spans in a transaction: each replaces the stored one with the same first page, and the
// range they cover, before and after, is marked for regrouping. Returns the jobs whose span moved.
export function saveSpans(tx: Db, sourceId: string, spans: SpanFacts[]) {
  const pages = spans.map((s) => s.firstPage);
  const old =
    pages.length === 0
      ? []
      : tx
          .select({
            endAt: timelineSpans.endAt,
            firstPage: timelineSpans.firstPage,
            startAt: timelineSpans.startAt,
          })
          .from(timelineSpans)
          .where(
            and(
              eq(timelineSpans.sourceId, sourceId),
              inArray(timelineSpans.firstPage, pages)
            )
          )
          .all();
  for (const { firstPage, startAt, endAt, ...facts } of spans) {
    const row = { endAt: new Date(endAt), facts, startAt: new Date(startAt) };
    tx.insert(timelineSpans)
      .values({ ...row, firstPage, sourceId })
      .onConflictDoUpdate({
        set: row,
        target: [timelineSpans.sourceId, timelineSpans.firstPage],
      })
      .run();
  }
  const edges = [
    ...spans.flatMap((s) => [Date.parse(s.startAt), Date.parse(s.endAt)]),
    ...old.flatMap((o) => [o.startAt.getTime(), o.endAt.getTime()]),
  ];
  if (edges.length > 0) {
    markDirty(tx, [sourceId], [Math.min(...edges), Math.max(...edges)]);
  }
  return movedUnderJobs(tx, sourceId, old, spans);
}

// The longest pause a stretch of recording runs through.
const STRETCH_GAP = MIN;
// How far before a range a span overlapping it may start. A span is one unbroken stretch of capture (the longest
// held is under 5 h), so one unbroken for over 7 days is read only for its first 7.
const LONGEST_SPAN = 7 * DAY;

// Recorded (docs/timeline.md): the stretches a Pendant recorded that overlap `[from, to)`, oldest first, whole
// (not cut at the range), spans under `STRETCH_GAP` apart joined; and the start of the first span held (`since`,
// null with none): before it lifelog cannot tell. Old-app recordings are no Pendant's.
export function recorded(db: Pick<Db, "select">, from: Date, to: Date) {
  const pendants = () =>
    db
      .select({ endAt: timelineSpans.endAt, startAt: timelineSpans.startAt })
      .from(timelineSpans)
      .innerJoin(sources, eq(sources.id, timelineSpans.sourceId));
  const first = pendants()
    .where(isPendant)
    .orderBy(asc(timelineSpans.startAt))
    .limit(1)
    .get();
  const spans = pendants()
    .where(
      and(
        isPendant,
        overlapping(timelineSpans.startAt, timelineSpans.endAt, {
          cut: from.getTime(),
          stop: to.getTime(),
        }),
        gte(timelineSpans.startAt, new Date(from.getTime() - LONGEST_SPAN))
      )
    )
    .all();
  return {
    since: first?.startAt.toISOString() ?? null,
    // The union joins what overlaps or touches: each end is pushed out by the gap for it, then brought back.
    stretches: unioned(
      spans.map((s) => [s.startAt.getTime(), s.endAt.getTime() + STRETCH_GAP])
    ).map(([start, end]) => ({
      endAt: new Date(end - STRETCH_GAP).toISOString(),
      startAt: new Date(start).toISOString(),
    })),
  };
}
