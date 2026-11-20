// Dictation on the phone (routes/dictation.ts): the server's record of it, on the server's clock. It
// starts when the server opens it (the microphone opens only on that answer) and ends when the close
// arrives (the microphone stops before it), or at its cap, which ends one never closed. It touches no
// pendant audio: the iPhone,
// whose clock stamps both its dictation and the pendant audio it uploads, marks or drops that audio
// before upload (docs/decisions.md, life#802).

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { phoneDictations } from "@lifelog/db/schema/phone-dictations";
import { eq } from "drizzle-orm";
import { z } from "zod";

// A dictation lasts at most this long: a close that never comes (lost, the phone gone) ends it here.
export const DICTATION_CAP_MS = 10 * 60_000;
// A new open whose tap, by the phone's clock, is further than this from the server's is stale: it
// arrived after the phone gave up on it.
const OPEN_WITHIN_MS = 60_000;

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
const viewOf = (row: Row) => ({
  endedAt: row.endedAt?.toISOString() ?? null,
  endsBy: new Date(capOf(row)).toISOString(),
  id: row.id,
  startedAt: row.startedAt.toISOString(),
});

// Opens a dictation at `now`, before its microphone opens. Its id is looked up first: an open again
// (a retry, however late) answers it as first opened, never moving its cap; one closed, or past its
// cap, is never opened again. Only a new open is checked for staleness.
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
    if (known && (known.endedAt || capOf(known) <= now.getTime())) {
      return "closed" as const;
    }
    if (known) {
      return viewOf(known);
    }
    if (
      Math.abs(Date.parse(input.startedAt) - now.getTime()) > OPEN_WITHIN_MS
    ) {
      return "stale" as const;
    }
    const row = { ...input, endedAt: null, startedAt: now };
    tx.insert(phoneDictations).values(row).run();
    return viewOf(row);
  });
}

// Closes a dictation (Stop, cancel, an interruption, a failed start) at `now`, when its close
// arrives, no later than its cap. A close again keeps the first end. The dictation as stored; null
// for an id never opened.
export function closePhoneDictation(db: Db, id: string, now = clock()) {
  return db.transaction((tx) => {
    const known = tx
      .select()
      .from(phoneDictations)
      .where(eq(phoneDictations.id, id))
      .get();
    if (!known || known.endedAt) {
      return known ? viewOf(known) : null;
    }
    const endedAt = new Date(Math.min(now.getTime(), capOf(known)));
    tx.update(phoneDictations)
      .set({ endedAt })
      .where(eq(phoneDictations.id, id))
      .run();
    return viewOf({ ...known, endedAt });
  });
}
