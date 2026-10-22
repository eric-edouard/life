import { z } from "zod";
import { SourceName } from "../core/names";
import {
  ContentHash,
  isoDate,
  isoDateTime,
  Salience,
  slug,
  UnitId,
} from "./fields";
import { MadeBy } from "./ledger";
import { ChapterKind, MemoryType } from "./observations";

// Memory's units (memory/units/, docs/SCHEMA.md), their verdicts, files, zones and labels. Every record carries
// schemaVersion and, when a model judged it, the model and prompt version.
/**
 * memory/verdicts.jsonl: the moments model's judgement of one unit's content (`unit` + `hash`), append-only. The latest
 * line for a (unit, hash) wins; a unit a code rule dropped (`Unit.drop`) has none that counts.
 */
export const Verdict = z
  .object({
    // An id from truth/areas.yaml, or null when none fits.
    area: slug.nullable(),
    hash: ContentHash,
    kind: ChapterKind.optional(),
    madeBy: MadeBy,
    reason: z.string(),
    salience: Salience,
    schemaVersion: z.literal(1),
    // 1-3 lowercase English tags for what the unit is about (`bun life memory topics`); none before memory-triage.v3.
    topics: z.array(z.string().min(1)).max(3).default([]),
    type: MemoryType,
    unit: UnitId,
    // A date or deadline the unit carries, whatever its type.
    when: isoDate.nullable(),
  })
  .strict();
export type Verdict = z.infer<typeof Verdict>;
/**
 * memory/files.jsonl: what Life read off one file a message carried (`SourceFile.ref`), append-only; the latest line for
 * a ref wins. `what` is the model's one sentence; `text` the words on the file (by code: a PDF's text layer, a
 * document; no `madeBy`). `hash`: 16 hex of SHA-256 over its bytes, so a copy met elsewhere is read once.
 */
export const FileEntry = z
  .object({
    hash: ContentHash,
    madeBy: MadeBy.optional(),
    ref: z.string(),
    schemaVersion: z.literal(1),
    text: z.string().optional(),
    what: z.string().optional(),
  })
  .strict();
export type FileEntry = z.infer<typeof FileEntry>;
/** L1: one lifelog chapter, one chat-day or one mail thread-day. Refs, hashes and metadata; never raw text. */
export const Unit = z
  .object({
    date: isoDate,
    // The code rule that dropped the unit as obvious noise (units.ts RULES); absent when none did.
    drop: z.string().optional(),
    end: isoDateTime,
    hash: ContentHash,
    id: UnitId,
    // The conversation, chat or mail thread the unit belongs to.
    key: z.string(),
    // lifelog: the refs of the turns of his "hey Life" spans in it (the hearing's marks); absent when none.
    marked: z.array(z.string()).optional(),
    // As the source names them, unresolved (unknown:<name or sender>, person:me): readers map them (`unitNow`, who.ts).
    people: z.array(z.string()),
    // lifelog: conversation#turns and jobId:turnIndex@capturedAt; chats: first and last message id; mail: message ids.
    refs: z.array(z.string()).min(1),
    schemaVersion: z.literal(1),
    source: SourceName,
    start: isoDateTime,
    stats: z
      .object({
        // Git only: lines added and removed that day, and other authors' commits by name (items counts all of them).
        added: z.int().min(0).optional(),
        chars: z.int().min(0),
        fromMe: z.int().min(0),
        items: z.int().min(0),
        others: z.record(z.string(), z.int().min(1)).optional(),
        removed: z.int().min(0).optional(),
      })
      .strict(),
    // lifelog's own chapter summary; chats and mail have none.
    summary: z.string().optional(),
    title: z.string(),
  })
  .strict();
export type Unit = z.infer<typeof Unit>;
/** memory/zones.jsonl: the owner's IANA time zone from `from` on. */
export const Zone = z
  .object({ from: isoDateTime, schemaVersion: z.literal(1), tz: z.string() })
  .strict();
/** The owner's label on a unit: does it matter, and optionally the right type and area (an id from truth/areas.yaml). memory/labels.jsonl. */
export const MemoryLabel = z
  .object({
    area: z.string().optional(),
    at: isoDateTime.optional(),
    matters: z.boolean(),
    schemaVersion: z.literal(1).optional(),
    type: MemoryType.optional(),
    unitId: UnitId,
  })
  .strict();
export type MemoryLabel = z.infer<typeof MemoryLabel>;
