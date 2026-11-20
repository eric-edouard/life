// Quiet ranges: stretches the owner spent dictating to the Mac (its events, turned into ranges by
// dictation.ts) or on the phone (opened before its microphone, `openQuietRange`), or the phone
// played a recording out loud (`POST /quiet-ranges`). Words inside one are hidden (transcript.ts
// `keptWords`). The Mac also vouches for time: every dictation before its watermark is already
// among the ranges, or the Mac is asleep. The processing limit is the earlier of that watermark and
// the start of a phone dictation still open (`processingLimit`).

import { randomUUID } from "node:crypto";
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { type Dictation, macWatch, quietRanges } from "@lifelog/db/schema";
import { openQuietRanges } from "@lifelog/db/schema/open-quiet-ranges";
import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { logChange, logPlacedIn } from "./change-log";
import {
  blocked,
  type DictatedRange,
  heldFrom,
  idle,
  type MacReport,
  settle,
  step,
  unblocked,
} from "./dictation";
import { markDirty, pendantSources } from "./grouping";
import type { MacSocket, MacView } from "./mac-socket";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

// The Mac drops anything over 10 minutes before padding; a little more passes for the padding.
// Longer is a stuck microphone flag, never a dictation.
const QUIET_MAX_MS = 11 * 60_000;
// A quiet range as `POST /quiet-ranges` carries it.
export const quietRangeInput = z
  .object({
    endedAt: z.iso.datetime({ offset: true }),
    id: z.uuid(),
    source: z
      .string()
      .min(1)
      .max(200)
      .describe('The dictating app\'s bundle id, or "playback" from the phone'),
    startedAt: z.iso.datetime({ offset: true }),
  })
  .refine((r) => Date.parse(r.endedAt) > Date.parse(r.startedAt), {
    message: "endedAt must be after startedAt",
  })
  .refine(
    (r) => Date.parse(r.endedAt) - Date.parse(r.startedAt) <= QUIET_MAX_MS,
    { message: "a quiet range lasts at most 11 minutes" }
  );

function insertQuietRange(
  tx: Tx,
  range: { endedAt: Date; id: string; source: string; startedAt: Date }
) {
  const stored = tx
    .insert(quietRanges)
    .values(range)
    .onConflictDoNothing()
    .returning({ id: quietRanges.id })
    .all();
  if (stored.length > 0) {
    const span: [Date, Date] = [range.startedAt, range.endedAt];
    // Dictation is not conversation: grouping covers it again (the tick, if nothing sooner).
    if (range.source !== "playback") {
      markDirty(tx, pendantSources(tx), span);
    }
    // The turns it hides words of read differently now.
    logChange(tx, "quietRange", range.id);
    logPlacedIn(tx, [span]);
  }
}

// Stores a quiet range. Posting one again (a retry) changes nothing and returns it as stored.
export function addQuietRange(
  db: Db,
  range: { endedAt: string; id: string; source: string; startedAt: string }
) {
  db.transaction((tx) =>
    insertQuietRange(tx, {
      ...range,
      endedAt: new Date(range.endedAt),
      startedAt: new Date(range.startedAt),
    })
  );
  const row = db
    .select()
    .from(quietRanges)
    .where(eq(quietRanges.id, range.id))
    .get();
  if (!row) {
    throw new Error(`quiet range ${range.id} not stored`);
  }
  return quietView(row);
}

const quietView = (row: typeof quietRanges.$inferSelect) => ({
  endedAt: row.endedAt.toISOString(),
  id: row.id,
  startedAt: row.startedAt.toISOString(),
});

// The Mac's row; none before it ever spoke.
export const macRow = (db: Pick<Db, "select">) =>
  db.select().from(macWatch).get();

// Stores the dictation rules' new state, the ranges they made, when the Mac was last heard (in
// server time: a Mac clock running ahead never vouches for the future; never moved back) and the
// last event applied (its seq, and its time as the Mac sent it). Wakes the feed's long polls; `mac`
// comes whole on every page.
function saveMac(
  tx: Tx,
  { ranges, state }: { ranges: DictatedRange[]; state: Dictation },
  heard: Date,
  last?: { at: number; seq: number }
) {
  const row = macRow(tx);
  const heardAt = new Date(
    Math.max(
      Math.min(heard.getTime(), clock().getTime()),
      row?.heardAt.getTime() ?? 0
    )
  );
  for (const r of ranges) {
    insertQuietRange(tx, {
      endedAt: new Date(r.endedAt),
      id: randomUUID(),
      source: r.source,
      startedAt: new Date(r.startedAt),
    });
  }
  const kept = { lastAt: row?.lastAt ?? null, lastSeq: row?.lastSeq ?? 0 };
  const set = {
    heardAt,
    state,
    ...(last ? { lastAt: new Date(last.at), lastSeq: last.seq } : kept),
  };
  tx.insert(macWatch)
    .values(set)
    .onConflictDoUpdate({ set, target: macWatch.id })
    .run();
  logChange(tx, "mac", "mac");
}

// One event from the Mac, applied once (by its seq), with the ranges it closes. `at` is capped at
// the server's now; `sent` is its time as the Mac said it. A seq no greater than the last applied is
// a resend (null), unless it was sent after the last one applied: then the Mac's count went back
// (a lost outbox file), the event is new, and it is refused ("behind") rather than dropped. Events
// are applied in the order sent, so one vouches for every event before it: the Mac is heard through
// its time, and a block (an event refused before it) clears.
export function applyMacEvent(
  db: Db,
  event: MacReport & { sent: number; seq: number }
) {
  return db.transaction((tx) => {
    const row = macRow(tx);
    if (row && event.seq <= row.lastSeq) {
      return event.sent > (row.lastAt?.getTime() ?? 0) ? "behind" : null;
    }
    const cleared = unblocked(row?.state ?? idle, event.at);
    const next = step(cleared.state, event);
    const applied = { ...next, ranges: [...cleared.ranges, ...next.ranges] };
    saveMac(tx, applied, new Date(event.at), {
      at: event.sent,
      seq: event.seq,
    });
    return applied;
  });
}

// An event from the Mac was refused: nothing after the last time it was heard is vouched for until
// an event applies again, however long that takes. `lost`: it was invalid and the helper drops it,
// so that span becomes a quiet range once the next event applies. Returns since when it holds.
export function blockMac(db: Db, { lost = false } = {}) {
  return db.transaction((tx) => {
    const row = macRow(tx);
    const heardAt = row?.heardAt ?? clock();
    const state = blocked(row?.state ?? idle, heardAt.getTime(), lost);
    saveMac(tx, { ranges: [], state }, heardAt);
    return new Date(state.blockedSince ?? heardAt.getTime());
  });
}

// Time passing on the Mac to `now`: stores a dictation done waiting for a neighbour (at once when
// `closed`: the socket went), and lets a stuck flag go. Returns the ranges stored.
export function settleMac(db: Db, now: Date, { closed = false } = {}) {
  return db.transaction((tx) => {
    const row = macRow(tx);
    if (!row) {
      return [];
    }
    const next = settle(row.state, now.getTime(), closed);
    if (next.state !== row.state) {
      saveMac(tx, next, row.heardAt);
    }
    return next.ranges;
  });
}

// The Mac heard at `heardAt` (a hello, ping or pong, sent after everything it sent before), and
// awake when it said hello. Returns the ranges stored.
export function storeMacHeard(db: Db, heardAt: Date, { awake = false } = {}) {
  return db.transaction((tx) => {
    const state = macRow(tx)?.state ?? idle;
    const next = awake
      ? step(state, { at: heardAt.getTime(), kind: "wake" })
      : { ranges: [], state };
    saveMac(tx, next, heardAt);
    return next.ranges;
  });
}

// The watermark: through `until` (now while the socket is open, else when the Mac was last heard),
// held back to a dictation not yet among the ranges. Asleep counts only with nothing held.
export function macView(
  { heardAt, state }: { heardAt: Date; state: Dictation },
  until: Date = heardAt
): MacView {
  const held = heldFrom(state, until.getTime());
  return {
    asleep: state.asleep && held === null,
    heardAt: heardAt.toISOString(),
    watchedThrough: new Date(
      held !== null && held < until.getTime() ? held : until.getTime()
    ).toISOString(),
  };
}

// The quiet ranges touching [start, end), as epoch-ms intervals.
export const quietIn = (
  db: Pick<Db, "select">,
  [start, end]: [number, number]
) =>
  db
    .select()
    .from(quietRanges)
    .where(
      and(
        lt(quietRanges.startedAt, new Date(end)),
        gt(quietRanges.endedAt, new Date(start))
      )
    )
    .all()
    .map((q): [number, number] => [q.startedAt.getTime(), q.endedAt.getTime()]);

// A dictation on the phone lasts at most this long: a close that never comes (lost, the phone gone)
// ends it here.
export const DICTATION_CAP_MS = 10 * 60_000;
// A phone dictation's range is on the server's clock: it starts when the server opens it (the
// microphone opens only on that answer) and ends when the close arrives (the microphone stops
// before it), so the phone's clock never places it. A pendant's audio is placed by its uploader's
// clock (an Omi stamps whole seconds by the Android phone's), which may differ from the server's by
// this much: the range is widened by it at both edges, and holds the processing limit from this
// before its start.
export const CLOCK_MARGIN_MS = 2000;
// A new open whose tap, by the phone's clock, is further than this from the server's is stale: it
// arrived after the phone gave up on it. It places nothing.
const OPEN_WITHIN_MS = 60_000;

// A phone dictation as its open carries it.
export const openQuietRangeInput = z.object({
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
type Open = typeof openQuietRanges.$inferSelect;

const openView = (row: Open) => ({
  endsBy: new Date(row.startedAt.getTime() + DICTATION_CAP_MS).toISOString(),
  id: row.id,
  startedAt: row.startedAt.toISOString(),
});

// Opens a phone dictation's range at `now`, before its microphone opens: from now the processing
// limit stops at its start. Its id is looked up first: an open again (a retry, however late)
// answers the range as first opened, never moving its cap; one already closed is never opened
// again. Only a new open is checked for staleness.
export function openQuietRange(
  db: Db,
  input: z.infer<typeof openQuietRangeInput>,
  now = clock()
) {
  return db.transaction((tx) => {
    const closed = tx
      .select({ id: quietRanges.id })
      .from(quietRanges)
      .where(eq(quietRanges.id, input.id))
      .get();
    if (closed) {
      return "closed" as const;
    }
    const opened = () =>
      tx
        .select()
        .from(openQuietRanges)
        .where(eq(openQuietRanges.id, input.id))
        .get();
    const known = opened();
    if (known) {
      return openView(known);
    }
    if (
      Math.abs(Date.parse(input.startedAt) - now.getTime()) > OPEN_WITHIN_MS
    ) {
      return "stale" as const;
    }
    tx.insert(openQuietRanges)
      .values({ ...input, startedAt: now })
      .run();
    const row = opened();
    if (!row) {
      throw new Error(`open quiet range ${input.id} not stored`);
    }
    return openView(row);
  });
}

// A phone dictation ends at `endedAt`, server time (no later than its cap): its range, widened by the clock
// margin, becomes a quiet range in the transaction that drops its open row, with the quiet range
// write's own feed change and regrouping.
function finish(tx: Tx, open: Open, endedAt: number) {
  const start = open.startedAt.getTime();
  const end = Math.min(Math.max(endedAt, start), start + DICTATION_CAP_MS);
  insertQuietRange(tx, {
    endedAt: new Date(end + CLOCK_MARGIN_MS),
    id: open.id,
    source: open.source,
    startedAt: new Date(start - CLOCK_MARGIN_MS),
  });
  tx.delete(openQuietRanges).where(eq(openQuietRanges.id, open.id)).run();
}

// Closes a phone dictation (Stop, cancel, an interruption, a failed start) at `now`, when its close
// arrives. A close again keeps the first end. The range as stored; null for an id never opened.
export function closeQuietRange(db: Db, id: string, now = clock()) {
  db.transaction((tx) => {
    const open = tx
      .select()
      .from(openQuietRanges)
      .where(eq(openQuietRanges.id, id))
      .get();
    if (open) {
      finish(tx, open, now.getTime());
    }
  });
  const row = db.select().from(quietRanges).where(eq(quietRanges.id, id)).get();
  return row ? quietView(row) : null;
}

// Ends every phone dictation past its cap there (its close lost, or the phone gone): at the
// server's start, before any work, and at each cap. How many ended, and when the next cap falls
// (null with none open).
export function settleOpenQuietRanges(db: Db, now = clock()) {
  return db.transaction((tx) => {
    const caps = tx
      .select()
      .from(openQuietRanges)
      .all()
      .map((open) => ({
        cap: open.startedAt.getTime() + DICTATION_CAP_MS,
        open,
      }));
    const due = caps.filter((c) => c.cap <= now.getTime());
    for (const { cap, open } of due) {
      finish(tx, open, cap);
    }
    const left = caps.filter((c) => c.cap > now.getTime()).map((c) => c.cap);
    return {
      ended: due.length,
      next: left.length > 0 ? Math.min(...left) : null,
    };
  });
}

// The processing limit: up to when pendant audio may be labeled, cut and sent, whichever phone
// uploaded it. The Mac's watermark, held back to the start of the earliest phone dictation still
// open, less the clock margin. Page labeling, the cutter and the job worker's claim and dispatch
// read it, and nothing else reads the watermark to process.
export const processingLimit =
  (db: Pick<Db, "select">, mac: Pick<MacSocket, "vouchedThrough">) => () => {
    const vouched = mac.vouchedThrough();
    const open = db
      .select({ startedAt: openQuietRanges.startedAt })
      .from(openQuietRanges)
      .orderBy(openQuietRanges.startedAt)
      .limit(1)
      .get();
    const held =
      (open?.startedAt.getTime() ?? Number.POSITIVE_INFINITY) - CLOCK_MARGIN_MS;
    return held < vouched.getTime() ? new Date(held) : vouched;
  };
