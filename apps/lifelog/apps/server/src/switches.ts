// The owner's switches for paid processing, set from the app or `bun run switches`. Off, nothing
// new is sent: uploads wait unsent (jobs.ts), voices aren't embedded (speech-service.ts), no summary is
// due (rolling.ts). Turned back on, what waited goes on by itself. Summaries
// (`ai`) are off by default: Life reads the words, not them. Search's embeddings run on the Mac and
// follow no switch (search.ts). `transcriber` picks who transcribes the next blocks: Scribe whole, or the
// speech service with Scribe for the turns it routes (jobs.ts).

import type { Db } from "@lifelog/db";
import {
  type MacEngine,
  processingSwitches,
  type Transcriber,
} from "@lifelog/db/schema";
import { logChange } from "./change-log";
import { record } from "./events";

export interface Switches {
  ai: boolean;
  engine: MacEngine;
  openAppAfterMinutes: number;
  transcriber: Transcriber;
  transcription: boolean;
}

const DEFAULTS: Switches = {
  ai: false,
  engine: "claude",
  openAppAfterMinutes: 15,
  transcriber: "scribe",
  transcription: true,
};

// ponytail: a cache in this process, right for one replica; read the row per check if the
// server ever runs more than one.
let current = DEFAULTS;
export const switches = (): Switches => current;

export function loadSwitches(db: Db) {
  const row = db.select().from(processingSwitches).get();
  current = row
    ? {
        ai: row.ai,
        engine: row.engine,
        openAppAfterMinutes: row.openAppAfterMinutes,
        transcriber: row.transcriber,
        transcription: row.transcription,
      }
    : DEFAULTS;
  return current;
}

// Returns the switches before and after.
export function setSwitches(
  db: Db,
  patch: {
    ai?: boolean | undefined;
    transcription?: boolean | undefined;
    engine?: MacEngine | undefined;
    openAppAfterMinutes?: number | undefined;
    transcriber?: Transcriber | undefined;
  }
) {
  const before = loadSwitches(db);
  const after: Switches = {
    ai: patch.ai ?? before.ai,
    engine: patch.engine ?? before.engine,
    openAppAfterMinutes:
      patch.openAppAfterMinutes ?? before.openAppAfterMinutes,
    transcriber: patch.transcriber ?? before.transcriber,
    transcription: patch.transcription ?? before.transcription,
  };
  db.transaction((tx) => {
    tx.insert(processingSwitches)
      .values({ id: 1, ...after })
      .onConflictDoUpdate({
        set: { ...after, updatedAt: new Date() },
        target: processingSwitches.id,
      })
      .run();
    // Wakes the feed's long polls; `switches` come whole on every page.
    logChange(tx, "switches", "switches");
  });
  current = after;
  record(db, "switches.changed", { ...after });
  return { after, before };
}
