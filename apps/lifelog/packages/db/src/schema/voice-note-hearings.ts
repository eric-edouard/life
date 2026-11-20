import { clock } from "@life/server/src/core/clock";
import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { instant } from "./columns";

// A chat voice note heard for Life (POST /voice-notes/transcript), by its original file's sha256: the
// claim taken before any Scribe send, so a note is paid for once. `localText` is the speech service's
// words, kept before the send; `text` and `doneAt` are its answer once settled.
export const voiceNoteHearings = sqliteTable("voice_note_hearings", {
  claimedAt: instant("claimed_at").notNull().$defaultFn(clock),
  doneAt: instant("done_at"),
  key: text("key").primaryKey(),
  localText: text("local_text").notNull(),
  text: text("text"),
});
