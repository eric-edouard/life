import { sqliteTable, text } from "drizzle-orm/sqlite-core";
import { instant, uuid } from "./columns";

// A dictation on the phone (phone-dictations.ts), on the server's clock: from when the server
// opened it to when its close arrived, or its cap; `endedAt` is null while it is open. It holds no
// ticket, audio or words, and touches no pendant audio.
export const phoneDictations = sqliteTable("phone_dictations", {
  endedAt: instant("ended_at"),
  id: uuid("id").primaryKey(),
  // The phone that opened it.
  phoneId: text("phone_id").notNull(),
  // The app the owner dictated in, by bundle id.
  source: text("source").notNull(),
  startedAt: instant("started_at").notNull(),
});
