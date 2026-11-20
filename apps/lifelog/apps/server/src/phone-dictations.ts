// Dictation on the phone (routes/dictation.ts): what the server keeps of it, and where it falls in
// each source's audio. Its range is on the server's clock: it starts when the server opens it (the
// microphone opens only on that answer) and ends when the close arrives (the microphone stops before
// it), or at its cap. A source's audio is on its uploader's clock, which the uploader measures against
// the server's and reports (`X-Clock-Offset`), kept as it changes (`recordSourceClock`). One rule
// places a dictation on a source's audio, by the clock rows that may have stamped it (`placedOf`):
// while open it holds the source back from there (`processingLimit`), once closed it is a range of it
// (`quietFor`), and one it can't place holds the source whole. Every step reads these where audio
// leaves: when Silero takes a piece, before a block's job is admitted, at each send and before the
// excerpts go to identity.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { quietRanges } from "@lifelog/db/schema";
import {
  phoneDictations,
  sourceClocks,
} from "@lifelog/db/schema/phone-dictations";
import { and, desc, eq, gt, isNull, lt, notExists, or } from "drizzle-orm";
import { z } from "zod";
import type { MacSocket } from "./mac-socket";
import type { Interval } from "./page-rules";
import { insertQuietRange, quietView, type Tx } from "./quiet-ranges";

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
// arrives. A close again keeps the first end. Its quiet range as stored; null for an id never opened
// as a phone dictation.
export function closePhoneDictation(db: Db, id: string, now = clock()) {
  const row = db.transaction((tx) => {
    const known = tx
      .select()
      .from(phoneDictations)
      .where(eq(phoneDictations.id, id))
      .get();
    if (known && !known.endedAt) {
      finish(tx, known, now.getTime());
    }
    return known
      ? tx.select().from(quietRanges).where(eq(quietRanges.id, id)).get()
      : undefined;
  });
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
const CLOCK_OFFSET = /^(-?\d{1,15}),(\d{1,15})$/;
export function parseClockOffset(header: string | undefined) {
  const [, offset, uncertainty] = CLOCK_OFFSET.exec(header ?? "") ?? [];
  const offsetMs = Number(offset);
  return offset && uncertainty && Math.abs(offsetMs) <= MAX_OFFSET_MS
    ? { offsetMs, uncertaintyMs: Number(uncertainty) }
    : null;
}

type Clock = typeof sourceClocks.$inferSelect;
const clocksOf = (db: Pick<Db, "select">, sourceId: string | null): Clock[] =>
  sourceId
    ? db
        .select()
        .from(sourceClocks)
        .where(eq(sourceClocks.sourceId, sourceId))
        .orderBy(sourceClocks.measuredAt)
        .all()
    : [];

// What a source's uploader says of its clock. Kept as a new row, in force from now, only when the
// clock moved past both uncertainties or is known better than the row in force: the earlier rows stay,
// for the audio stamped while they held.
export function recordSourceClock(
  db: Db,
  sourceId: string,
  measured: { offsetMs: number; uncertaintyMs: number },
  now = clock()
) {
  const [last] = db
    .select()
    .from(sourceClocks)
    .where(eq(sourceClocks.sourceId, sourceId))
    .orderBy(desc(sourceClocks.measuredAt))
    .limit(1)
    .all();
  const isNews =
    !last ||
    measured.uncertaintyMs < last.uncertaintyMs ||
    Math.abs(measured.offsetMs - last.offsetMs) >
      measured.uncertaintyMs + last.uncertaintyMs;
  if (isNews) {
    db.insert(sourceClocks)
      .values({ ...measured, measuredAt: now, sourceId })
      .onConflictDoNothing()
      .run();
  }
}

// The one placement rule: a dictation on a source's audio, by every clock row that may have stamped
// that audio (the one in force at its start, any added while it ran, and the first added after it),
// each shifting it by its offset and widening it by its uncertainty and the margin; one still open
// runs on. Null when no row was in force at its start, or one of them is too unsure: it can't be
// placed, and the source is held (`processingLimit`).
function placedOf(clocks: Clock[], row: Row): Interval[] | null {
  const start = row.startedAt.getTime();
  const end = row.endedAt?.getTime() ?? ALL_TIME;
  const from = clocks.findLastIndex((c) => c.measuredAt.getTime() <= start);
  const after = clocks.findIndex((c) => c.measuredAt.getTime() >= end);
  const inForce =
    from < 0 ? [] : clocks.slice(from, after < 0 ? undefined : after + 1);
  if (
    inForce.length === 0 ||
    inForce.some((c) => c.uncertaintyMs > MAX_UNCERTAINTY_MS)
  ) {
    return null;
  }
  return inForce.map((c) => {
    const wide = c.uncertaintyMs + CLOCK_MARGIN_MS;
    return [
      start + c.offsetMs - wide,
      row.endedAt ? end + c.offsetMs + wide : ALL_TIME,
    ];
  });
}

// The protected time touching [start, end) of a source's audio, on its uploader's clock: the quiet
// ranges stored on it (the Mac's, playback), and each closed phone dictation placed on it
// (`placedOf`; its server-clock copy among the quiet ranges is for words and grouping, not for
// audio). One still open, or one that can't be placed, is the limit's (`processingLimit`): what it
// holds waits, never withdrawn.
export function quietFor(
  db: Pick<Db, "select">,
  sourceId: string | null,
  [start, end]: Interval
): Interval[] {
  const stored = db
    .select()
    .from(quietRanges)
    .where(
      and(
        lt(quietRanges.startedAt, new Date(end)),
        gt(quietRanges.endedAt, new Date(start)),
        notExists(
          db
            .select({ id: phoneDictations.id })
            .from(phoneDictations)
            .where(eq(phoneDictations.id, quietRanges.id))
        )
      )
    )
    .all()
    .map((q): Interval => [q.startedAt.getTime(), q.endedAt.getTime()]);
  const clocks = clocksOf(db, sourceId);
  if (clocks.length === 0) {
    return stored;
  }
  // Any dictation a row could shift into [start, end).
  const reach =
    Math.max(...clocks.map((c) => Math.abs(c.offsetMs) + c.uncertaintyMs)) +
    CLOCK_MARGIN_MS;
  const placed = db
    .select()
    .from(phoneDictations)
    .where(
      and(
        lt(phoneDictations.startedAt, new Date(end + reach)),
        gt(phoneDictations.endedAt, new Date(start - reach))
      )
    )
    .all()
    .flatMap((row) => placedOf(clocks, row) ?? [])
    .filter(([a, b]) => a < end && b > start);
  return [...stored, ...placed];
}

// The processing limit: up to when a source's audio may be labeled, cut and sent. The Mac's
// watermark, held back to the earliest start of a phone dictation still open as placed on the source
// (`placedOf`), and held whole while any phone dictation can't be placed on it. Page labeling, the
// cutter, the job worker and the excerpts read it, and nothing else reads the watermark to process.
export const processingLimit =
  (db: Pick<Db, "select">, mac: Pick<MacSocket, "vouchedThrough">) =>
  (sourceId: string | null) => {
    const vouched = mac.vouchedThrough();
    const clocks = clocksOf(db, sourceId);
    const open = db
      .select()
      .from(phoneDictations)
      .where(isNull(phoneDictations.endedAt))
      .all()
      .map((row) => placedOf(clocks, row));
    const held = isUnplaceable(db, clocks)
      ? -ALL_TIME
      : Math.min(
          ...open.map((p) => (p ? Math.min(...p.map(([a]) => a)) : -ALL_TIME))
        );
    return held < vouched.getTime() ? new Date(held) : vouched;
  };

// Whether a closed phone dictation can't be placed on a source with these clock rows: one before its
// first row, or one a row too unsure may have stamped (`placedOf`).
function isUnplaceable(db: Pick<Db, "select">, clocks: Clock[]) {
  const first = clocks[0]?.measuredAt ?? new Date(ALL_TIME);
  const unsure = clocks.flatMap((c, i) =>
    c.uncertaintyMs > MAX_UNCERTAINTY_MS
      ? [
          and(
            lt(
              phoneDictations.startedAt,
              clocks[i + 1]?.measuredAt ?? new Date(ALL_TIME)
            ),
            gt(
              phoneDictations.endedAt,
              clocks[i - 1]?.measuredAt ?? new Date(-ALL_TIME)
            )
          ),
        ]
      : []
  );
  return Boolean(
    db
      .select({ id: phoneDictations.id })
      .from(phoneDictations)
      .where(or(lt(phoneDictations.startedAt, first), ...unsure))
      .limit(1)
      .get()
  );
}
