// One map build at a time, off the request thread; keep the displayed snapshot while it refreshes.
import type { Db } from "@lifelog/db";
import { sql } from "drizzle-orm";
import { latestSeq } from "./change-log";
import { reportError } from "./diagnostics";
import type { Card, readVoiceMap } from "./naming-queue";

type VoiceMap = ReturnType<typeof readVoiceMap> & { building?: boolean };

export interface QueueCache {
  items: () => Card[] | Promise<Card[]>;
  map: () => VoiceMap | null;
}

export function queueCache(db: Db) {
  let worker: Worker | null = null;
  let map: VoiceMap | null = null;
  let seen: number | null = null;
  let pending: ReturnType<typeof Promise.withResolvers<void>> | null = null;
  const close = () => {
    worker?.terminate();
    worker = null;
    pending?.resolve();
    pending = null;
  };
  const failed = (error: unknown) => {
    close();
    reportError(db, "voice map", error);
  };
  const readMap = (): VoiceMap | null => {
    const revision = latestSeq(db);
    if (!pending && seen !== revision) {
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
      pending = Promise.withResolvers<void>();
    }
    if (map) {
      map.building = pending !== null;
    }
    return map;
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
          break; // A failed build keeps the last completed snapshot.
        }
      }
      if (!map) {
        throw new Error("Voice map worker could not build the naming queue");
      }
      return map.cards
        .filter((card) => card.scope === "speaker")
        .map(({ scope: _, ...card }) => card);
    },
    map: readMap,
  };
}
