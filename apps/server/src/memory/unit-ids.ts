import { digest } from "../core/hash";
import type { SourceEvent } from "../records/source";
import { localDate } from "./zones";

// A unit's id, by its recipe: one place, below units.ts, so any step can count what a call read by the units' real ids.

export const unitId = (...parts: string[]) =>
  `unit_${digest("sha1", parts.join("|"), 12)}`;
/** The id of the chat-day (thread-day, note-day, repo-day, device-day, measurement-day or photo-day) an event is in. */
export const dayUnitId = (e: SourceEvent) =>
  unitId(e.source, e.chat, localDate(e.at));
/** The voice source's old name, kept as the recipe's first part so no stored voice unit's id changes (the rename of 28 Nov 2026). */
const VOICE_UNIT_SALT = "lifelog";
/** The id of a recorded conversation's day (its conversation-day). */
export const voiceUnitId = (conversation: string, date: string) =>
  unitId(VOICE_UNIT_SALT, conversation, date);
