import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { instant, uuid } from "./columns";

// A dictation on the phone while it lasts (quiet-ranges.ts `openQuietRange`): its start is known,
// its end not yet. It holds the processing limit at its start until it closes, or until its cap
// when the close never comes; then it becomes a quiet range of the same id and this row goes, in
// one transaction. It holds no ticket, audio or words.
export const openQuietRanges = sqliteTable("open_quiet_ranges", {
  id: uuid("id").primaryKey(),
  // The phone that opened it.
  phoneId: text("phone_id").notNull(),
  // The app the owner dictated in, by bundle id.
  source: text("source").notNull(),
  startedAt: instant("started_at").notNull(),
});
