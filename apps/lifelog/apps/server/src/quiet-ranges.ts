// Quiet ranges: stretches the owner spent dictating to the Mac (its events, turned into ranges by
// dictation.ts) or the phone played a recording out loud (`POST /quiet-ranges`). Words inside one
// are hidden (transcript-visibility.ts `keptWords`). The Mac also vouches for time: every dictation before its
// watermark is already among the ranges, or the Mac is asleep.

import { randomUUID } from "node:crypto";
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { type Dictation, macWatch, quietRanges } from "@lifelog/db/schema";
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
import type { MacView } from "./mac-socket";

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
