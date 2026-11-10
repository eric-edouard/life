// Private evidence snapshots are shared by hash; all replay writes stay on a disposable copy.
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "@lifelog/db";
import { sql } from "drizzle-orm";

const hashOf = (body: string) =>
  createHash("sha256").update(body).digest("hex");
const captured = new WeakMap<
  ReturnType<typeof connect>,
  { version: string; hash: string; body: string }
>();

export function freezeVoiceSnapshot(
  db: ReturnType<typeof connect>,
  snapshots: Record<string, string>
) {
  const version = JSON.stringify(
    db.all(sql`select total_changes() as changes,
    (select * from pragma_data_version) as data_version, (select * from pragma_schema_version) as schema_version`)
  );
  let snapshot = captured.get(db);
  if (snapshot?.version !== version) {
    const body = Buffer.from(db.$client.serialize()).toString("base64");
    snapshot = { body, hash: hashOf(body), version };
    captured.set(db, snapshot);
  }
  snapshots[snapshot.hash] ??= snapshot.body;
  return snapshot.hash;
}

export function withFrozenVoiceSnapshot<T>(
  snapshots: Record<string, string>,
  hash: string,
  read: (db: ReturnType<typeof connect>) => T
) {
  const body = snapshots[hash];
  if (!body || hashOf(body) !== hash) {
    throw new Error("frozen snapshot hash mismatch");
  }
  const directory = mkdtempSync(join(tmpdir(), "lifelog-frozen-"));
  let db: ReturnType<typeof connect> | undefined;
  try {
    const file = join(directory, "archive.sqlite");
    writeFileSync(file, Buffer.from(body, "base64"));
    db = connect(file);
    return read(db);
  } finally {
    try {
      db?.$client.close(true);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  }
}
