import { Database } from "bun:sqlite";

/**
 * A SQLite store opened to write, in WAL mode. The wait comes first: a reader rebuilding the WAL index just after
 * the last connection closed otherwise makes the next statement fail at once with "database is locked".
 */
export function openWritable(
  path: string,
  busyMs = 5000,
  options?: ConstructorParameters<typeof Database>[1]
) {
  const db = new Database(path, options);
  db.run(`pragma busy_timeout = ${busyMs}`);
  db.run("pragma journal_mode = wal");
  return db;
}

/**
 * A SQLite store opened to read, never to write: an app's store, Life's archive or its search index, which their
 * writers update meanwhile. It waits up to 5 s for a writer instead of failing at once with "database is locked",
 * which readers running side by side (the bench's runs, the night beside the archive) otherwise hit.
 */
export function openReadOnly(path: string) {
  const db = new Database(path, { readonly: true });
  db.run("pragma busy_timeout = 5000");
  return db;
}
