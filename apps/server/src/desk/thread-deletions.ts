import type { Database } from "bun:sqlite";
import { clock } from "../core/clock";
import { deletionsNow } from "../memory/memory-files";

// His deletion on the Life thread: an entry a `deleted` correction names (`thread:<id>`, `deleteFromMemory`) is blanked
// in place by the desk, the only writer of its store: words, answer and screen emptied, `deleted_at` set, the row and its
// time kept. The thread hides it at read meanwhile (`readThread`). A quiet line a deletion names (`quiet:<assignment>@<rev>`)
// is deleted the same way, hidden at read meanwhile (`quietLineOf`).

const ENTRY = /^thread:(\d+)$/;
const QUIET = /^quiet:(.+)@([^@]+)$/;

/** Every thread entry a deletion names, not yet blanked, blanked now; how many. Run on each tick and before an answer is written. */
export function blankDeletedThreadEntries(db: Database) {
  const ids = [...deletionsNow().refs].flatMap((r) => {
    const n = ENTRY.exec(r)?.[1];
    return n ? [Number(n)] : [];
  });
  const blank = db.prepare(
    "update thread_entry set words = '', answer = '', screen = null, deleted_at = ? where id = ? and deleted_at is null"
  );
  // A question the main session asked from it (`main_question`) holds his words too: it goes.
  const question = db.prepare("delete from main_question where entry = ?");
  const quiet = db.prepare(
    "delete from quiet_line where assignment_id = ? and rev = ?"
  );
  const at = clock().toISOString();
  return db.transaction(() => {
    for (const r of deletionsNow().refs) {
      const [, id, rev] = QUIET.exec(r) ?? [];
      if (id && rev) {
        quiet.run(id, rev);
      }
    }
    return ids.reduce((n, id) => {
      question.run(id);
      return n + blank.run(at, id).changes;
    }, 0);
  })();
}
