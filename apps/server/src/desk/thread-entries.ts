import { clock } from "../core/clock";
import type { MainSessionAsk } from "../records/main-session-wire";
import type { Desk } from "./desk-store";

// The thread entries of his asks (`thread_entry`, the desk's store: `desk-store.ts`): the one place that opens one,
// reads one by its key, ends one with a line and puts a reaction on one. The main session writes its answers
// (`main-session.ts`); a late reply of an agent and his deletions have their own writers (`agent-questions.ts`,
// `thread-deletions.ts`).

/** His ask as a new thread entry: its id. */
export const openEntry = (db: Desk["db"], ask: MainSessionAsk) =>
  Number(
    db.run(
      "insert into thread_entry (ask_key, asked_at, words, screen) values (?, ?, ?, ?)",
      [
        ask.key ?? null,
        clock().toISOString(),
        ask.words ?? "",
        ask.screen ? JSON.stringify(ask.screen) : null,
      ]
    ).lastInsertRowid
  );

interface StoredEntry {
  answer: string | null;
  answered_at: string | null;
  deleted_at: string | null;
  error: string | null;
  id: number;
  refs: string;
  turn_id: number | null;
  words: string | null;
}

/** The thread entry of the ask kept under key `key`, if any: answered once `answered_at` is set (an answer or an error). */
export const askEntryOf = (db: Desk["db"], key: string) =>
  db
    .query<StoredEntry, [string]>(
      "select id, words, answer, error, refs, answered_at, deleted_at, turn_id from thread_entry where ask_key = ?"
    )
    .get(key);

/** Ends entry `entry` with line `why`, answered now when `isEnded` (else a retry under its key asks again); never a deleted one. */
export const endEntryWith = (
  db: Desk["db"],
  entry: number,
  why: string,
  isEnded: unknown
) =>
  db.run(
    "update thread_entry set error = ?, answered_at = ? where id = ? and deleted_at is null",
    [why, isEnded ? clock().toISOString() : null, entry]
  );

/** Puts reaction `r` by `by` on entry `entry`'s words (Life's) or answer (his), once each. Whether it was put. */
export function react(
  db: Desk["db"],
  entry: number,
  by: "life" | "owner",
  r: string
) {
  const row = db
    .query<{ reactions: string }, [number]>(
      "select reactions from thread_entry where id = ? and deleted_at is null"
    )
    .get(entry);
  if (!row) {
    return false;
  }
  const reactions = JSON.parse(row.reactions) as {
    at: string;
    by: string;
    with: string;
  }[];
  if (reactions.some((x) => x.by === by && x.with === r)) {
    return false;
  }
  reactions.push({ at: clock().toISOString(), by, with: r });
  db.run("update thread_entry set reactions = ? where id = ?", [
    JSON.stringify(reactions),
    entry,
  ]);
  return true;
}
