import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { instant, uuid } from "./columns";

// A dictation on the phone (phone-dictations.ts), on the server's clock: from when the server
// opened it to when its close arrived, or its cap; `endedAt` is null while it is open. Its range,
// widened, is also a quiet range of the same id (for words already bought and grouping); this row is
// what processing places on each uploader's clock. It holds no ticket, audio or words.
export const phoneDictations = sqliteTable(
  "phone_dictations",
  {
    endedAt: instant("ended_at"),
    id: uuid("id").primaryKey(),
    // The phone that opened it.
    phoneId: text("phone_id").notNull(),
    // The app the owner dictated in, by bundle id.
    source: text("source").notNull(),
    startedAt: instant("started_at").notNull(),
  },
  (t) => [index("phone_dictations_started_at").on(t.startedAt)]
);

// How far a source's uploader's clock is from the server's (its clock less the server's), and how
// sure: what its last upload said (`X-Clock-Offset`), measured from a round trip with the server's
// `X-Server-Time`. A source with none can't be placed against a phone dictation.
export const sourceClocks = sqliteTable("source_clocks", {
  measuredAt: instant("measured_at").notNull(),
  offsetMs: integer("offset_ms").notNull(),
  sourceId: text("source_id").primaryKey(),
  uncertaintyMs: integer("uncertainty_ms").notNull(),
});
