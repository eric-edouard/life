// The raw side of the archive (rebuild P7): everything the Pendant heard, kept in the bucket so
// the archive survives losing the phone. Raw packs hold dictation to the Mac too, so they are
// stored and never processed: they sit under `raw/`, nothing here reads an object back, and
// nothing else in the server knows these keys (backup.test.ts checks). Only speech blocks with
// quiet ranges removed (`blocks/`, `jobs/`) go to ElevenLabs, `apps/identity` or a model. The
// server's own archive is copied beside them once a day (`archive/`): the file on its disk is
// otherwise the only copy. With restic set up, restic.ts snapshots it instead.

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { backupFiles, transcriptionJobs } from "@lifelog/db/schema";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { type AudioStore, audioKey, storeAudio } from "./audio-store";
import { sha256Hex } from "./config";
import { reportError } from "./diagnostics";
import type { Job } from "./jobs";

export const MAX_BACKUP_BYTES = 64 * 1024 * 1024;
// Snapshots kept per source (the phone's source.sqlite, the server's archive), one per UTC date.
const SNAPSHOTS_KEPT = 7;

export interface RawFile {
  key: string;
  kind: "pack" | "source_db" | "archive";
  name: string;
  sha256: string;
  sourceId: string;
}

export const rawPack = (
  sourceId: string,
  name: string,
  sha256: string
): RawFile => ({
  key: `raw/${sourceId}/${name}-${sha256}.pack`,
  kind: "pack",
  name,
  sha256,
  sourceId,
});

// A snapshot is named by the UTC date it arrived; a later one that day replaces it.
export const rawSnapshot = (
  sourceId: string,
  sha256: string,
  now = clock()
): RawFile => {
  const date = now.toISOString().slice(0, 10);
  return {
    key: `raw/${sourceId}/source-db/${date}-${sha256}.sqlite`,
    kind: "source_db",
    name: date,
    sha256,
    sourceId,
  };
};

// The server's archive, copied whole and consistent (`VACUUM INTO`) once per UTC date, kept like
// the phone's snapshots; its keyword index is rebuilt when restored (docs/transcription-server.md). False when today's is kept already or the bucket failed (index.ts tries
// again within the hour). ponytail: the copy runs on the event loop and is read whole into
// memory, a few seconds a night; stream it, off the loop, when the archive outgrows a few hundred MB.
export async function snapshotArchive(
  db: Db,
  audio: AudioStore,
  now = clock()
) {
  const date = now.toISOString().slice(0, 10);
  const kept = db
    .select({ key: backupFiles.key })
    .from(backupFiles)
    .where(and(eq(backupFiles.kind, "archive"), eq(backupFiles.name, date)))
    .get();
  if (kept) {
    return false;
  }
  const file = join(tmpdir(), `lifelog-archive-${randomUUID()}.sqlite`);
  try {
    db.run(sql`vacuum into ${file}`);
    const bytes = await Bun.file(file).bytes();
    const sha256 = sha256Hex(bytes);
    return await keepRaw(
      db,
      audio,
      {
        key: `archive/${date}-${sha256}.sqlite`,
        kind: "archive",
        name: date,
        sha256,
        sourceId: "server",
      },
      bytes
    );
  } finally {
    await rm(file, { force: true });
  }
}

export function isKept(db: Db, key: string) {
  const row = db
    .select({ key: backupFiles.key })
    .from(backupFiles)
    .where(eq(backupFiles.key, key))
    .get();
  return row !== undefined;
}

// Stores a verified file and records it, then drops the snapshots past the last 7 dates: their rows
// in the transaction, their objects after it. A failed object delete is logged and leaks that
// object (no row names it, nothing retries it); the file itself is kept. False when the bucket
// failed: nothing is recorded, and the phone sends it again.
export async function keepRaw(
  db: Db,
  audio: AudioStore,
  file: RawFile,
  bytes: Uint8Array
) {
  if (!(await storeAudio(audio, file.key, bytes, "application/octet-stream"))) {
    return false;
  }
  const dropped = db.transaction((tx) => {
    tx.insert(backupFiles)
      .values({ ...file, bytes: bytes.length })
      .onConflictDoNothing()
      .run();
    if (file.kind === "pack") {
      return [];
    }
    const rows = tx
      .select({ key: backupFiles.key, name: backupFiles.name })
      .from(backupFiles)
      .where(
        and(
          eq(backupFiles.sourceId, file.sourceId),
          eq(backupFiles.kind, file.kind)
        )
      )
      // Newest first within a date: rowid breaks a tie in the same millisecond.
      .orderBy(
        desc(backupFiles.name),
        desc(backupFiles.createdAt),
        desc(sql`rowid`)
      )
      .all();
    const dates = new Set<string>();
    const drop = rows.filter((row) => {
      const first = !dates.has(row.name) && dates.size < SNAPSHOTS_KEPT;
      dates.add(row.name);
      return !first;
    });
    const keys = drop.map((row) => row.key);
    if (keys.length > 0) {
      tx.delete(backupFiles).where(inArray(backupFiles.key, keys)).run();
    }
    return keys;
  });
  await Promise.all(
    dropped.map((key) =>
      audio
        .delete(key)
        .catch((error: unknown) => reportError(db, "snapshot delete", error))
    )
  );
  return true;
}

// What the server holds of a source, so the phone sends only what is missing.
export function backupOf(db: Db, sourceId: string) {
  const rows = db
    .select()
    .from(backupFiles)
    .where(eq(backupFiles.sourceId, sourceId))
    .orderBy(backupFiles.name)
    .all();
  // The newest date: retention keeps one snapshot per date.
  const latest = rows.findLast((row) => row.kind === "source_db");
  return {
    latestSnapshot: latest && {
      bytes: latest.bytes,
      date: latest.name,
      sha256: latest.sha256,
      uploadedAt: latest.createdAt.toISOString(),
    },
    packs: rows
      .filter((row) => row.kind === "pack")
      .map(({ bytes, name, sha256 }) => ({ bytes, name, sha256 })),
  };
}

// The prepared Ogg of a completed job, re-rendered by the phone. It goes under the job's own key,
// or `jobs/<sha>.ogg`; the job itself is untouched: nothing is admitted, sent or billed. Null
// when the bucket failed.
export async function backfillAudio(
  db: Db,
  audio: AudioStore,
  job: Job,
  bytes: Uint8Array
) {
  const key = job.objectKey ?? audioKey(job.audioSha256);
  if (!(await storeAudio(audio, key, bytes))) {
    return null;
  }
  db.update(transcriptionJobs)
    .set({ objectKey: key })
    .where(
      and(eq(transcriptionJobs.id, job.id), isNull(transcriptionJobs.objectKey))
    )
    .run();
  return key;
}

// `GET /status`: the packs held, the newest snapshot, and how many completed jobs still lack
// their audio in the bucket (the P7 backfill's progress).
export function backupStatus(db: Db) {
  const [packs] = db.all<{ bytes: number; count: number }>(
    sql`select count(*) as count, coalesce(sum(bytes), 0) as bytes
      from backup_files where kind = 'pack'`
  );
  const [snapshot] = db.all<{ at: number | null }>(
    sql`select max(created_at) as at from backup_files where kind = 'source_db'`
  );
  const [jobs] = db.all<{ with: number | null; without: number | null }>(
    sql`select sum(object_key is not null) as "with", sum(object_key is null) as without
      from transcription_jobs where state = 'completed'`
  );
  return {
    jobsWithAudio: jobs?.with ?? 0,
    jobsWithoutAudio: jobs?.without ?? 0,
    latestSnapshotAt: snapshot?.at ? new Date(snapshot.at).toISOString() : null,
    packBytes: packs?.bytes ?? 0,
    packs: packs?.count ?? 0,
  };
}
