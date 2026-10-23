import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { readJson, writeJson } from "../core/files";
import { LIFE_STATE_DIR } from "../core/paths";
import { SECRETS, same, writeSecret } from "../core/secret";
import { settings } from "../core/settings";
import { ARCHIVED, type Archived, keptStores } from "../memory/sources";
import { ARCHIVE, archiveDb, insertAll } from "../sources/archived";
import { MAX_BODY } from "./http/http";

// The Mac companion (docs/architecture.md, "The Mac companion"): a Mac whose Life only archives the Mac-only apps and
// pushes its archive to the hub, a server's Life, which holds a row-for-row copy (same tables, same rowids) read by the
// same readers. The archive only ever grows (rows are inserted, never changed), so each table's cursor is the hub's
// own largest rowid, and a row sent twice is ignored by its rowid: nothing is kept on the Mac, nothing counted twice.
// The Mac's archive is only read here.

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** A new token for the companion, shown once: only its hash is kept, and it revokes the one before. */
export function mintCompanionToken() {
  const token = randomBytes(32).toString("base64url");
  writeSecret("companion", sha256(token));
  return token;
}

/** Whether `token` is the companion's (none minted: never). */
export const isCompanionToken = (token: string) =>
  same(
    sha256(token),
    existsSync(SECRETS.companion) ? readFileSync(SECRETS.companion, "utf8") : ""
  );

/** The tables of an archive store, as its own schema makes them. */
const tablesIn = (db: Database) =>
  db
    .query<{ name: string }, []>(
      "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name"
    )
    .all()
    .map((t) => t.name);

/** The hub's largest rowid of each table of each archive store, as `<store>.<table>`: where each push resumes. */
export function heldThrough(dir = ARCHIVE) {
  const held: Record<string, number> = {};
  for (const { name, store } of ARCHIVED) {
    const db = store.open(dir);
    try {
      for (const t of tablesIn(db)) {
        held[`${name}.${t}`] =
          db
            .query<{ n: number }, []>(
              `select coalesce(max(rowid), 0) as n from "${t}"`
            )
            .get()?.n ?? 0;
      }
    } finally {
      db.close();
    }
  }
  return held;
}

const Value = z.union([z.string(), z.number(), z.null()]);
export const Push = z
  .object({
    rows: z.array(
      z.object({ rowid: z.number().int().positive() }).catchall(Value)
    ),
    store: z.string(),
    table: z.string(),
  })
  .strict();
export type Push = z.infer<typeof Push>;

/**
 * Stores a push in the hub's archive, each row under its Mac rowid (`insert or ignore`: a resend is a no-op); how many
 * rows were new. A store, table or column its own schema lacks throws: nothing of the wire becomes SQL.
 */
export function receive({ rows, store, table }: Push, dir = ARCHIVE) {
  const archived = ARCHIVED.find((s) => s.name === store);
  if (!archived) {
    throw new Error(`no archive store ${store}`);
  }
  const db = archived.store.open(dir);
  try {
    if (!tablesIn(db).includes(table)) {
      throw new Error(`no table ${store}.${table}`);
    }
    const columns = db
      .query<{ name: string }, []>(`pragma table_info("${table}")`)
      .all()
      .map((c) => c.name);
    const known = new Set(["rowid", ...columns]);
    for (const row of rows) {
      const unknown = Object.keys(row).find((k) => !known.has(k));
      if (unknown) {
        throw new Error(`no column ${store}.${table}.${unknown}`);
      }
    }
    return insertAll(
      db,
      `insert or ignore into "${table}" (rowid, ${columns.map((c) => `"${c}"`).join(", ")})
       values (${["?", ...columns.map(() => "?")].join(", ")})`,
      rows.map((r) => [r.rowid, ...columns.map((c) => r[c] ?? null)])
    );
  } finally {
    db.close();
  }
}

/** When the companion last reached the hub: with each store's last copy (`lastCopied`), its status on the hub. */
const REACHED = join(LIFE_STATE_DIR, "companion.json");

export const noteReached = () =>
  writeJson(REACHED, { at: clock().toISOString() });

export const companionReachedAt = () =>
  readJson<{ at: string }>(REACHED)?.at ?? null;

// Rows read from the Mac's archive at once; a batch over the hub's body limit is split in two until it fits.
const ROWS = 2000;

/**
 * Pushes every row of the kept stores' archive the hub doesn't hold yet, table by table in rowid order; how many rows
 * were sent. A failed call throws, and the next push resumes from what the hub holds.
 */
export async function push(
  hub: string,
  token: string,
  dir = ARCHIVE,
  stores: Archived[] = keptStores()
) {
  const call = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(new URL(path, hub), {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      throw new Error(`${path}: ${res.status} ${await res.text()}`);
    }
    return res;
  };
  const send = async (batch: Push): Promise<void> => {
    const body = Bun.gzipSync(JSON.stringify(batch));
    if (body.length > MAX_BODY && batch.rows.length > 1) {
      const half = Math.floor(batch.rows.length / 2);
      await send({ ...batch, rows: batch.rows.slice(0, half) });
      return send({ ...batch, rows: batch.rows.slice(half) });
    }
    // ponytail: one row whose compressed size passes MAX_BODY (a note of megabytes) stops its table, failing each push
    // until the hub takes larger bodies.
    await call("/companion/push", {
      body,
      headers: {
        "content-encoding": "gzip",
        "content-type": "application/json",
      },
      method: "POST",
    });
  };
  const held = (await (await call("/companion/cursors")).json()) as Record<
    string,
    number
  >;
  let sent = 0;
  for (const { name } of stores) {
    const path = archiveDb(name, dir);
    if (!existsSync(path)) {
      continue;
    }
    const db = new Database(path, { readonly: true });
    try {
      for (const table of tablesIn(db)) {
        let through = held[`${name}.${table}`] ?? 0;
        const next = db.query<Push["rows"][number], [number]>(
          `select rowid as rowid, * from "${table}" where rowid > ? order by rowid limit ${ROWS}`
        );
        for (
          let rows = next.all(through);
          rows.length > 0;
          rows = next.all(through)
        ) {
          // biome-ignore lint/performance/noAwaitInLoops: each batch resumes after the last
          await send({ rows, store: name, table });
          sent += rows.length;
          through = rows.at(-1)?.rowid ?? through;
        }
      }
    } finally {
      db.close();
    }
  }
  return sent;
}

/** The hub and token this Mac pushes to; undefined when it is no companion (`off("companion")` says why). */
export const companionOf = () => {
  const hub = settings().companion?.hub;
  const token = process.env.LIFE_COMPANION_TOKEN;
  return hub && token ? { hub, token } : undefined;
};
