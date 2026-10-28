import { Database } from "bun:sqlite";

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
