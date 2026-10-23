// The archive: one SQLite file, one process writing it (docs/voice/architecture.md). Queries run
// synchronously, so a transaction is a plain function: nothing else runs while it does, and its
// body never awaits (apps/voice/AGENTS.md).
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { count, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { migrate } from "drizzle-orm/bun-sqlite/migrator";
import type { BaseSQLiteDatabase, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  conversations,
  diagnostics,
  embeddingCalls,
  heartbeats,
  intelligenceRuns,
  macWatch,
  people,
  quietRanges,
  searchIndex,
  searchPassages,
  speakerAssignments,
  transcriptionJobs,
  transcripts,
  voiceProfiles,
  voiceSamples,
} from "./schema";

export const schema = {
  conversations,
  diagnostics,
  embeddingCalls,
  heartbeats,
  intelligenceRuns,
  macWatch,
  people,
  quietRanges,
  searchIndex,
  searchPassages,
  speakerAssignments,
  transcriptionJobs,
  transcripts,
  voiceProfiles,
  voiceSamples,
};

// Satisfied by both the database and a transaction.
export type Db = BaseSQLiteDatabase<"sync", void, typeof schema>;

// The rows of `table` matching `where`, read synchronously (`db.$count` answers only through a
// promise).
export const countRows = (db: Db, table: SQLiteTable, where?: SQL) =>
  db.select({ n: count() }).from(table).where(where).get()?.n ?? 0;

// The server's own connection, or a script's read-only one (`readonly`: the live archive). Close it with
// `$client.close(true)`: a plain `close()` keeps the file open until Drizzle's statements are collected, and Windows
// can't remove or rename an open file.
export function connect(file: string, { readonly = false } = {}) {
  const client = new Database(file, readonly ? { readonly } : { create: true });
  client.run("pragma busy_timeout = 5000");
  if (!readonly) {
    client.run("pragma journal_mode = wal");
    client.run("pragma synchronous = normal");
    client.run("pragma foreign_keys = on");
  }
  return drizzle({ client, schema });
}

// One server per archive: an exclusive lock on `<file>.lock`, held until the process ends (the OS
// drops it on a crash too). A second server throws here, before it migrates or ticks.
export function holdArchive(file: string) {
  const lock = new Database(`${file}.lock`, { create: true });
  try {
    lock.run("pragma locking_mode = exclusive");
    lock.run("begin exclusive");
  } catch (cause) {
    lock.close();
    throw new Error(`another server holds ${file}`, { cause });
  }
  return lock;
}

// Beside this file, or inside a compiled server's binary: `bun build --compile --asset` embeds the folder under its
// own name beside every module (apps/voice/scripts/build-host.ts).
export const MIGRATIONS = join(import.meta.dir, "migrations");

export const migrateDb = (db: ReturnType<typeof connect>) =>
  migrate(db, { migrationsFolder: MIGRATIONS });
