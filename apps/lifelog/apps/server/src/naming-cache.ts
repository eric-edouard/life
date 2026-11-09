// One map build at a time, off the request thread; keep the displayed snapshot while it refreshes.
import { clock, MIN } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { sql } from "drizzle-orm";
import { latestSeq } from "./change-log";
import { reportError } from "./diagnostics";
import type { Card, readVoiceMap } from "./naming-queue";

import type { VoiceScope } from "./voice-map";

export const MAP_RETRY_DELAY = MIN / 2;

type VoiceMap = ReturnType<typeof readVoiceMap> & { building?: boolean };

export interface QueueCache {
  items: () => Card[] | Promise<Card[]>;
  map: () => VoiceMap | null;
}

export function queueCache(db: Db) {
  let worker: Worker | null = null;
  let map: VoiceMap | null = null;
  let seen: number | null = null;
  let pending:
    | (ReturnType<typeof Promise.withResolvers<void>> & { revision: number })
    | null = null;
  let failure: { revision: number; retryAt: number } | null = null;
  const close = () => {
    worker?.terminate();
    worker = null;
    pending?.resolve();
    pending = null;
  };
  const failed = (error: unknown) => {
    if (pending) {
      failure = {
        retryAt: clock().getTime() + MAP_RETRY_DELAY,
        revision: pending.revision,
      };
    }
    close();
    reportError(db, "voice map", error);
  };
  const readMap = (): VoiceMap | null => {
    const revision = latestSeq(db);
    if (
      !pending &&
      seen !== revision &&
      !(failure?.revision === revision && clock().getTime() < failure.retryAt)
    ) {
      if (worker) {
        worker.postMessage(null);
      } else {
        const file = db.all<{ file: string }>(sql`pragma database_list`)[0]
          ?.file;
        if (!file) {
          throw new Error("Voice map requires a file-backed archive");
        }
        const w = new Worker(
          new URL("./voice-map-worker.ts", import.meta.url).href
        );
        (w as unknown as { unref: () => void }).unref();
        w.onmessage = ({
          data,
        }: MessageEvent<{ map: VoiceMap; seen: number }>) => {
          if (worker !== w) {
            return;
          }
          ({ map, seen } = data);
          failure = null;
          pending?.resolve();
          pending = null;
        };
        w.onerror = (event) => {
          if (worker === w) {
            failed(new Error(event.message));
          }
        };
        w.addEventListener("close", () => {
          if (worker === w) {
            failed(new Error("Voice map worker exited"));
          }
        });
        worker = w;
        worker.postMessage(file);
      }
      pending = { ...Promise.withResolvers<void>(), revision };
    }
    return map ? { ...map, building: pending !== null } : null;
  };
  return {
    close,
    async items() {
      const requested = latestSeq(db);
      // Catch up through this request, without chasing writes that arrive while it waits.
      while (seen === null || seen < requested) {
        const previous = map;
        readMap();
        // biome-ignore lint/performance/noAwaitInLoops: one in-flight snapshot; a newer request may need its successor
        await pending?.promise;
        if (map === previous) {
          break; // Keep the displayed map; queue readers must reject a stale snapshot.
        }
      }
      if (!map || seen === null || seen < requested) {
        throw new Error("Voice map worker could not build the naming queue");
      }
      const scope: VoiceScope = "speaker";
      return map.cards
        .filter((card) => card.scope === scope)
        .map(({ scope: _, ...card }) => card);
    },
    map: readMap,
  };
}
