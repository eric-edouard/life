// Titles the owner gives, from the phone or through a reader. Each edit carries the time it
// was made and the latest one wins. A phone edit made offline keeps its own time; a time in the
// future is clamped to now. An edit without a time is stamped now.

import type { Db } from "@lifelog/db";
import { conversations } from "@lifelog/db/schema";
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { logChange } from "./change-log";

// When an edit counts as made: its own time, never later than now.
const editTime = (editedAt: string | null | undefined, now = new Date()) =>
  editedAt ? new Date(Math.min(Date.parse(editedAt), now.getTime())) : now;

// The owner's title, set (or cleared, with null) unless a later edit is already stored. Two
// edits in the same millisecond: the one that arrives last wins.
// Returns the row as it stands after, or undefined for an unknown conversation.
export function setOwnerTitle(
  db: Db,
  id: string,
  title: string | null,
  editedAt?: string
) {
  const at = editTime(editedAt);
  return db.transaction((tx) => {
    const row = tx
      .update(conversations)
      .set({ ownerTitle: title, ownerTitleAt: at })
      .where(
        and(
          eq(conversations.id, id),
          or(
            isNull(conversations.ownerTitleAt),
            lte(conversations.ownerTitleAt, at)
          )
        )
      )
      .returning()
      .get();
    if (row) {
      logChange(tx, "conversation", id);
      return row;
    }
    return tx.query.conversations
      .findFirst({ where: eq(conversations.id, id) })
      .sync();
  });
}
