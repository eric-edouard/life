import { clock } from "@life/server/src/core/clock";
import { index, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { instant } from "./columns";

// A chat voice note heard for Life (POST /voice-notes/transcript), by its original file's sha256: the
// claim taken before any Scribe send, so a note is paid for once. `localText` is the speech service's
// words, kept before the send; `text` and `doneAt` are its answer once settled, with what it took: its seconds, how
// it was routed and the Scribe seconds billed (Life's model spending, `GET /spending`; null before 21 Nov 2026).
export const voiceNoteHearings = sqliteTable(
  "voice_note_hearings",
  {
    billableSeconds: real("billable_seconds"),
    claimedAt: instant("claimed_at").notNull().$defaultFn(clock),
    doneAt: instant("done_at"),
    key: text("key").primaryKey(),
    localText: text("local_text").notNull(),
    route: text("route"),
    seconds: real("seconds"),
    text: text("text"),
  },
  // What a span of days spent (`GET /spending`).
  (t) => [index("voice_note_hearings_done").on(t.doneAt)]
);
