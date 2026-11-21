import { clock } from "@life/server/src/core/clock";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { boolean, instant } from "./columns";

// Who transcribes a block: ElevenLabs Scribe whole, or the speech service with Scribe for the turns
// it routes (route-turns.ts). The owner's switch picks it; a job keeps the one it was sent with.
export const transcribers = ["scribe", "speech"] as const;
export type Transcriber = (typeof transcribers)[number];
export const macEngines = ["claude", "codex"] as const;
export type MacEngine = (typeof macEngines)[number];
// Where a field's dictation on the phone is heard: on the Mac after each pause (`POST
// /dictation/transcript`), or instantly, the phone streaming it to ElevenLabs' realtime Scribe with a
// token the Mac mints only then (`POST /live-words/token`). Not `transcriber`: that routes the
// Pendant's jobs.
export const dictationHearings = ["mac", "instant"] as const;
export type DictationHeard = (typeof dictationHearings)[number];

// The owner's switches, one row (switches.ts). Transcription: audio to ElevenLabs and voices to
// apps/identity. AI: summaries on the Mac. Off, that work waits. No row: `switches.ts` DEFAULTS.
export const processingSwitches = sqliteTable("processing_switches", {
  ai: boolean("ai").notNull(),
  dictationHeard: text("dictation_heard", { enum: dictationHearings })
    .notNull()
    .default("mac"),
  engine: text("engine", { enum: macEngines }).notNull().default("claude"),
  id: integer("id").primaryKey().default(1),
  // Minutes the Pendant's audio may wait on the phone before the server asks the owner to open
  // the app (latency.ts); 0 is off. Its default is `switches.ts` DEFAULTS.
  openAppAfterMinutes: integer("open_app_after_minutes").notNull(),
  transcriber: text("transcriber", { enum: transcribers })
    .notNull()
    .default("scribe"),
  transcription: boolean("transcription").notNull(),
  updatedAt: instant("updated_at").notNull().$defaultFn(clock),
});
