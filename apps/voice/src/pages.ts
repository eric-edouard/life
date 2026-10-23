// Phones send raw pages; the server decides what gets transcribed (docs/voice/processing.md, "Phones
// send pages"). This is the ingest half: a source's pages kept byte for byte, idempotent by
// index; page-processing.ts labels and cuts them.

import type { Db } from "@life/voice-db";
import { rawPages, sources } from "@life/voice-db/schema";
import { and, between, eq, max } from "drizzle-orm";
import { z } from "zod";
import { type AudioStore, pagesKey, storeAudio } from "./audio-store";
import { Sha256, sha256Hex } from "./config";
import { labeledUntil } from "./page-labels";

// What the phone sends beside the bytes (`PUT /sources/{id}/pages/{firstPage}`).
export const PageBatch = z.object({
  codec: z
    .enum(["limitless", "omi"])
    .describe(
      "How the bytes read: a Limitless `StorageBufferMsg` or an Omi ring record"
    ),
  pages: z
    .array(
      z.object({
        index: z
          .int()
          .min(0)
          .describe(
            "The phone's store index: the flash life times 2^40 plus the device's own index"
          ),
        length: z.int().min(1),
        startMs: z
          .int()
          .optional()
          .describe(
            "Capture placement, epoch ms; left out for an Omi record (the server places it from its stamp)"
          ),
      })
    )
    .min(1)
    .max(500),
  sha256: Sha256.describe("Of the `pages` part, whole"),
});
type PageBatch = z.infer<typeof PageBatch>;

// What the server holds of a source: a hint, not a resume cursor (docs/voice/sync.md), and how far it
// labeled.
export function ingestState(db: Pick<Db, "select">, sourceId: string) {
  const highest = db
    .select({ index: max(rawPages.pageIndex) })
    .from(rawPages)
    .where(eq(rawPages.sourceId, sourceId))
    .get()?.index;
  return {
    highestPage: highest ?? null,
    labeledUntil: labeledUntil(db, sourceId)?.toISOString() ?? null,
  };
}

// The batch's pages not stored yet, or the first stored index that holds other bytes.
function unstored<T extends { index: number; sha256: string }>(
  db: Db,
  sourceId: string,
  pages: T[]
) {
  const first = pages[0]?.index ?? 0;
  const stored = new Map(
    db
      .select({ index: rawPages.pageIndex, sha256: rawPages.sha256 })
      .from(rawPages)
      .where(
        and(
          eq(rawPages.sourceId, sourceId),
          between(rawPages.pageIndex, first, first + pages.length - 1)
        )
      )
      .all()
      .map((r) => [r.index, r.sha256])
  );
  const clash = pages.find(
    (p) => (stored.get(p.index) ?? p.sha256) !== p.sha256
  );
  if (clash) {
    return { conflict: clash.index };
  }
  return pages.filter((p) => !stored.has(p.index));
}

// Stores a batch of raw pages from `firstPage`, contiguous; idempotent below what is stored. The
// bytes go to the audio store before the transaction, and a refused batch keeps no row.
export async function storePages(
  db: Db,
  audio: AudioStore,
  sourceId: string,
  firstPage: number,
  batch: PageBatch,
  bytes: Uint8Array
): Promise<
  | ReturnType<typeof ingestState>
  | { conflict: number }
  | "unavailable"
  | { invalid: string }
> {
  if (sha256Hex(bytes) !== batch.sha256) {
    return { invalid: "pages do not match sha256" };
  }
  if (batch.pages.some((p, i) => p.index !== firstPage + i)) {
    return { invalid: "pages must be contiguous from firstPage" };
  }
  let offset = 0;
  const pages = batch.pages.map((p) => {
    const page = {
      ...p,
      offset,
      sha256: sha256Hex(bytes.subarray(offset, offset + p.length)),
    };
    offset += p.length;
    return page;
  });
  if (offset !== bytes.length) {
    return { invalid: "page lengths do not add up to the bytes sent" };
  }
  const fresh = unstored(db, sourceId, pages);
  if ("conflict" in fresh) {
    return fresh;
  }
  const key = pagesKey(sourceId, firstPage, batch.sha256);
  const type = "application/octet-stream";
  if (fresh.length > 0 && !(await storeAudio(audio, key, bytes, type))) {
    return "unavailable";
  }
  // The look again, under the one writer: a batch stored meanwhile is seen here. ponytail: a
  // conflict found only here leaves this batch's object in the store, unread and unnamed by any
  // row (as `storeFragment` does); sweep `pages/` keys no row names if that ever happens.
  return db.transaction((tx) => {
    const now = unstored(tx, sourceId, pages);
    if ("conflict" in now) {
      return now;
    }
    // The source exists once its pages do (page-processing.ts finds its sources there).
    tx.insert(sources).values({ id: sourceId }).onConflictDoNothing().run();
    if (now.length > 0) {
      tx.insert(rawPages)
        .values(
          now.map((p) => ({
            codec: batch.codec,
            length: p.length,
            objectKey: key,
            offset: p.offset,
            pageIndex: p.index,
            sha256: p.sha256,
            sourceId,
            startAt: p.startMs === undefined ? null : new Date(p.startMs),
          }))
        )
        .run();
    }
    return ingestState(tx, sourceId);
  });
}
