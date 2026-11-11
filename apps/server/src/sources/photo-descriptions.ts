import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock, DAY } from "../core/clock";
import { LIFE_STATE_DIR } from "../core/paths";
import { openReadOnly } from "../core/sqlite";

// Life's reading of each photo, one or two sentences (the glossary's description): written by the describer on the
// Mac (`host/describe-photos.ts`) or imported from the one-off cloud run, read back into the photo-days (`readPhotos`).
// Derived state, rebuildable at the cost of a model run, so not memory: a pass writes for hours outside the memory lock.
// The prompt is part of a row's key: a new prompt describes every photo again.

/** The prompt the rows are written with: `prompts/<name>.md`. */
export const PHOTOS_PROMPT = "photos.v1";
export const DESCRIPTIONS = join(
  LIFE_STATE_DIR,
  "memory",
  "photo-descriptions.sqlite"
);
/** A failed photo is tried again after this long; one with no image (Photos may fetch it from iCloud) after a week. */
const RETRY_FAILED = DAY;
const RETRY_NO_IMAGE = 7 * DAY;

/** `no-image`: Photos holds no image of it on this Mac to read. */
type Outcome = "described" | "failed" | "no-image";
export interface Description {
  /** Why it failed (`failed` only). */
  error?: string;
  /** The model that wrote it, as `<name>@<runner>`. */
  model: string;
  outcome: Outcome;
  /** Its words (`described` only). */
  text?: string;
  uuid: string;
}

const SCHEMA = `create table if not exists descriptions (
  uuid text not null, prompt text not null, outcome text not null, text text, error text, model text not null, at text not null,
  primary key (uuid, prompt)) without rowid`;

/** The rows read with `read`; none when the store is not made yet. */
function readRows<T>(read: (db: Database) => T, none: T, path: string) {
  if (!existsSync(path)) {
    return none;
  }
  const db = openReadOnly(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** The words of these photos that have a description. */
export function readDescriptions(uuids: string[], path = DESCRIPTIONS) {
  return readRows(
    (db) =>
      new Map(
        db
          .query<{ text: string; uuid: string }, [string, string]>(
            "select uuid, text from descriptions where prompt = ? and outcome = 'described' and uuid in (select value from json_each(?))"
          )
          .all(PHOTOS_PROMPT, JSON.stringify(uuids))
          .map((r) => [r.uuid, r.text])
      ),
    new Map<string, string>(),
    path
  );
}

/**
 * The photos with nothing left to try: described, or failed or without an image within their retry time. Every other
 * photo is waiting.
 */
export function readHandled(path = DESCRIPTIONS) {
  const since = (ms: number) => new Date(clock().getTime() - ms).toISOString();
  return readRows(
    (db) =>
      new Set(
        db
          .query<{ uuid: string }, [string, string, string]>(
            `select uuid from descriptions where prompt = ? and (outcome = 'described'
              or (outcome = 'failed' and at > ?) or (outcome = 'no-image' and at > ?))`
          )
          .all(PHOTOS_PROMPT, since(RETRY_FAILED), since(RETRY_NO_IMAGE))
          .map((r) => r.uuid)
      ),
    new Set<string>(),
    path
  );
}

/** How many photos are described and how many have no image, and the last failure with its time. */
export function readTally(path = DESCRIPTIONS) {
  return readRows(
    (db) => {
      const counts = new Map(
        db
          .query<{ n: number; outcome: Outcome }, [string]>(
            "select outcome, count(*) as n from descriptions where prompt = ? group by outcome"
          )
          .all(PHOTOS_PROMPT)
          .map((r) => [r.outcome, r.n])
      );
      return {
        described: counts.get("described") ?? 0,
        failure:
          db
            .query<{ at: string; error: string | null }, [string]>(
              "select at, error from descriptions where prompt = ? and outcome = 'failed' order by at desc limit 1"
            )
            .get(PHOTOS_PROMPT) ?? undefined,
        noImage: counts.get("no-image") ?? 0,
      };
    },
    { described: 0, failure: undefined, noImage: 0 },
    path
  );
}

/**
 * The one writer: the Mac's pass and the cloud import. A described photo is never written over (what the Mac described
 * stays); a failed one or one with no image is, by the next try.
 */
export function writeDescriptions(rows: Description[], path = DESCRIPTIONS) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.run("pragma busy_timeout = 30000");
    db.run("pragma journal_mode = wal");
    db.run(SCHEMA);
    const put = db.query(
      `insert into descriptions values (?, ?, ?, ?, ?, ?, ?)
       on conflict (uuid, prompt) do update set outcome = excluded.outcome, text = excluded.text, error = excluded.error,
         model = excluded.model, at = excluded.at where descriptions.outcome != 'described'`
    );
    const at = clock().toISOString();
    db.transaction(() => {
      for (const r of rows) {
        put.run(
          r.uuid,
          PHOTOS_PROMPT,
          r.outcome,
          r.text ?? null,
          r.error ?? null,
          r.model,
          at
        );
      }
    })();
  } finally {
    db.close();
  }
}
