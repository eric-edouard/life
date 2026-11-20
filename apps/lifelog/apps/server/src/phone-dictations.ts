// Dictation on the phone (routes/dictation.ts): what the server keeps of it, and where it falls in
// each source's audio. Its range is on the server's clock: it starts when the server opens it (the
// microphone opens only on that answer) and ends when the close arrives (the microphone stops before
// it), or at its cap. A source's audio is on its uploader's clock, which the uploader measures against
// the server's and reports (`X-Clock-Offset`, `recordSourceClock`). A dictation is placed on that
// clock, shifted by the offset and widened by its uncertainty and the margin (`quietFor`); a source
// with no usable measurement is held whole once any phone dictation exists (`processingLimit`), and
// goes on once one comes. Every step reads these where audio leaves: when Silero takes a piece, before
// a block's job is admitted, and at each send.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { quietRanges } from "@lifelog/db/schema";
import {
  phoneDictations,
  sourceClocks,
} from "@lifelog/db/schema/phone-dictations";
import { and, eq, gt, isNull, lt, or } from "drizzle-orm";
import { z } from "zod";
import type { MacSocket } from "./mac-socket";
import type { Interval } from "./page-rules";
import { insertQuietRange, quietIn, quietView, type Tx } from "./quiet-ranges";

// A dictation lasts at most this long: a close that never comes (lost, the phone gone) ends it here.
export const DICTATION_CAP_MS = 10 * 60_000;
// Added to each uploader's own uncertainty: a pendant's clock drifts from its phone's between drains,
// and an Omi stamps whole seconds.
export const CLOCK_MARGIN_MS = 2000;
// A new open whose tap, by the phone's clock, is further than this from the server's is stale: it
// arrived after the phone gave up on it.
const OPEN_WITHIN_MS = 60_000;
// A measurement less sure than this places nothing: the source is held until a better one comes.
const MAX_UNCERTAINTY_MS = 10_000;
const MAX_OFFSET_MS = 7 * 86_400_000;
const ALL_TIME = 8.64e15;

// A phone dictation as its open carries it.
export const phoneDictationInput = z.object({
  id: z.uuid(),
  phoneId: z.string().min(1).max(200).describe("The phone dictating"),
  source: z
    .string()
    .min(1)
    .max(200)
    .describe("The bundle id of the app the owner dictates in"),
  startedAt: z.iso
    .datetime({ offset: true })
    .describe(
      "The tap, by the phone's clock: a new open more than a minute from the server's clock is stale. The range starts when the server opens it"
    ),
});

type Row = typeof phoneDictations.$inferSelect;
const capOf = (row: Row) => row.startedAt.getTime() + DICTATION_CAP_MS;
const openView = (row: Row) => ({
  endsBy: new Date(capOf(row)).toISOString(),
  id: row.id,
  startedAt: row.startedAt.toISOString(),
});

// A dictation ends at `end` (server time, no later than its cap), and its range, widened by the
// margin, becomes a quiet range of the same id (words already bought hidden, grouping again).
function finish(tx: Tx, row: Row, end: number) {
  const start = row.startedAt.getTime();
  const endedAt = Math.min(Math.max(end, start), capOf(row));
  tx.update(phoneDictations)
    .set({ endedAt: new Date(endedAt) })
    .where(eq(phoneDictations.id, row.id))
    .run();
  insertQuietRange(tx, {
    endedAt: new Date(endedAt + CLOCK_MARGIN_MS),
    id: row.id,
    source: row.source,
    startedAt: new Date(start - CLOCK_MARGIN_MS),
  });
}

// Opens a dictation at `now`, before its microphone opens. Its id is looked up first: an open again
// (a retry, however late) answers it as first opened, never moving its cap; one closed, or past its
// cap (it ends there now), is never opened again. Only a new open is checked for staleness.
export function openPhoneDictation(
  db: Db,
  input: z.infer<typeof phoneDictationInput>,
  now = clock()
) {
  return db.transaction((tx) => {
    const known = tx
      .select()
      .from(phoneDictations)
      .where(eq(phoneDictations.id, input.id))
      .get();
    if (known?.endedAt) {
      return "closed" as const;
    }
    if (known && capOf(known) <= now.getTime()) {
      finish(tx, known, capOf(known));
      return "closed" as const;
    }
    if (known) {
      return openView(known);
    }
    if (
      Math.abs(Date.parse(input.startedAt) - now.getTime()) > OPEN_WITHIN_MS
    ) {
      return "stale" as const;
    }
    const row = { ...input, endedAt: null, startedAt: now };
    tx.insert(phoneDictations).values(row).run();
    return openView(row);
  });
}

// Closes a dictation (Stop, cancel, an interruption, a failed start) at `now`, when its close
// arrives. A close again keeps the first end. Its quiet range as stored; null for an id never opened.
export function closePhoneDictation(db: Db, id: string, now = clock()) {
  db.transaction((tx) => {
    const row = tx
      .select()
      .from(phoneDictations)
      .where(and(eq(phoneDictations.id, id), isNull(phoneDictations.endedAt)))
      .get();
    if (row) {
      finish(tx, row, now.getTime());
    }
  });
  const row = db.select().from(quietRanges).where(eq(quietRanges.id, id)).get();
  return row ? quietView(row) : null;
}

// Ends every dictation past its cap there (its close lost, or the phone gone): at the server's
// start, before any work, and at each cap. How many ended, and when the next cap falls (null with
// none open).
export function settlePhoneDictations(db: Db, now = clock()) {
  return db.transaction((tx) => {
    const open = tx
      .select()
      .from(phoneDictations)
      .where(isNull(phoneDictations.endedAt))
      .all();
    const due = open.filter((row) => capOf(row) <= now.getTime());
    for (const row of due) {
      finish(tx, row, capOf(row));
    }
    const left = open.filter((row) => capOf(row) > now.getTime()).map(capOf);
    return {
      ended: due.length,
      next: left.length > 0 ? Math.min(...left) : null,
    };
  });
}

// `X-Clock-Offset: <offset ms>,<uncertainty ms>`: the uploader's clock less the server's, and how
// sure, from its last round trip (`X-Server-Time`). Null when it isn't one.
export function parseClockOffset(header: string | undefined) {
  const [offset, uncertainty, ...rest] = (header ?? "").split(",").map(Number);
  const isClock =
    rest.length === 0 &&
    Number.isInteger(offset) &&
    Number.isInteger(uncertainty) &&
    Math.abs(offset ?? 0) <= MAX_OFFSET_MS &&
    (uncertainty ?? -1) >= 0;
  return isClock
    ? { offsetMs: offset ?? 0, uncertaintyMs: uncertainty ?? 0 }
    : null;
}

// What a source's uploader last said of its clock; the latest wins (a clock can jump).
export function recordSourceClock(
  db: Db,
  sourceId: string,
  measured: { offsetMs: number; uncertaintyMs: number },
  now = clock()
) {
  const set = { ...measured, measuredAt: now };
  db.insert(sourceClocks)
    .values({ ...set, sourceId })
    .onConflictDoUpdate({ set, target: sourceClocks.sourceId })
    .run();
}

// A source's clock, as placing needs it: its offset and how wide to widen. Null when it has no
// usable measurement.
function clockOf(db: Pick<Db, "select">, sourceId: string | null) {
  const measured = sourceId
    ? db
        .select()
        .from(sourceClocks)
        .where(eq(sourceClocks.sourceId, sourceId))
        .get()
    : undefined;
  return measured && measured.uncertaintyMs <= MAX_UNCERTAINTY_MS
    ? {
        offset: measured.offsetMs,
        wide: measured.uncertaintyMs + CLOCK_MARGIN_MS,
      }
    : null;
}

// The protected time touching [start, end) of a source's audio, on its uploader's clock: the quiet
// ranges as stored, and each phone dictation placed by that clock (one still open, to the end of
// time). A source with no usable clock is held by the limit instead (`processingLimit`).
export function quietFor(
  db: Pick<Db, "select">,
  sourceId: string | null,
  [start, end]: Interval
): Interval[] {
  const stored = quietIn(db, [start, end]);
  const at = clockOf(db, sourceId);
  if (!at) {
    return stored;
  }
  const from = start - at.offset - at.wide;
  const to = end - at.offset + at.wide;
  const placed = db
    .select()
    .from(phoneDictations)
    .where(
      and(
        lt(phoneDictations.startedAt, new Date(to)),
        or(
          isNull(phoneDictations.endedAt),
          gt(phoneDictations.endedAt, new Date(from))
        )
      )
    )
    .all()
    .map(
      (row): Interval => [
        row.startedAt.getTime() + at.offset - at.wide,
        row.endedAt ? row.endedAt.getTime() + at.offset + at.wide : ALL_TIME,
      ]
    );
  return [...stored, ...placed];
}

// The processing limit: up to when a source's audio may be labeled, cut and sent. The Mac's
// watermark, held back to the start of the earliest phone dictation still open, placed on the
// source's clock; a source with no usable clock is held whole once any phone dictation exists.
// Page labeling, the cutter and the job worker read it, and nothing else reads the watermark to
// process.
export const processingLimit =
  (db: Pick<Db, "select">, mac: Pick<MacSocket, "vouchedThrough">) =>
  (sourceId: string | null) => {
    const vouched = mac.vouchedThrough();
    const at = clockOf(db, sourceId);
    const open = db
      .select({ startedAt: phoneDictations.startedAt })
      .from(phoneDictations)
      .where(at ? isNull(phoneDictations.endedAt) : undefined)
      .orderBy(phoneDictations.startedAt)
      .limit(1)
      .get();
    if (!open) {
      return vouched;
    }
    const held = at
      ? open.startedAt.getTime() + at.offset - at.wide
      : -ALL_TIME;
    return held < vouched.getTime() ? new Date(held) : vouched;
  };
