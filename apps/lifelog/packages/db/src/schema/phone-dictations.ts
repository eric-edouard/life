import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
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

// A source's uploader's clock, as its uploads said it (`X-Clock-Offset`, measured from a round trip
// with the server's `X-Server-Time`): its clock less the server's, and how sure, in force from
// `measuredAt` (server time) until the source's next row. A row is added only when the clock moved
// past both uncertainties or is known better, so the audio of each moment is placed by the clock it
// was stamped with. A source with none can't be placed against a phone dictation.
export const sourceClocks = sqliteTable(
  "source_clocks",
  {
    measuredAt: instant("measured_at").notNull(),
    offsetMs: integer("offset_ms").notNull(),
    sourceId: text("source_id").notNull(),
    uncertaintyMs: integer("uncertainty_ms").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.measuredAt] })]
);
