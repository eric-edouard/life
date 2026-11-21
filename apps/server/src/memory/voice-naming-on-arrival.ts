import { CONVERSATION_ENDS_AFTER } from "../core/quiet";
import { VOICE_NAMING_READ } from "../records/read-reply";
import { turnRef } from "../sources/lifelog";
import {
  type NamingQueueItem,
  readNamingQueue,
  voiceKey,
} from "../sources/lifelog-voices";
import type { RecentVoice } from "./arrival-reader";
import { directChats, readWithPeople } from "./closeness";
import { exchangesOf } from "./exchanges";
import { READ_REPLIES } from "./memory-files";
import { isLocked } from "./memory-lock";
import { CALL_SLACK, PLANNED_WITHIN } from "./naming-context";
import { wordsOf } from "./page-format";
import { READS, readRepliesSince } from "./read-replies";
import { readCallsToday } from "./run-log";
import {
  type SpokenPart,
  type SpokenTurn,
  spokenPartsOf,
} from "./spoken-conversations";
import { voiceOfKey } from "./units";
import {
  isWorthNaming,
  jobOf,
  readVoiceNamingWork,
  voiceNaming,
} from "./voice-naming";
import type { People } from "./who";

// The voice naming on arrival (docs/glossary.md, "voice naming"): the watcher's daytime pass of the night's voice naming,
// his yes of 21 Nov 2026 to a third daytime model step. It asks during a conversation (a voice group said
// `LIVE_GROUP_WORDS`) or once lifelog closed it, never before a meeting, and asks and stores exactly as the night does.

const { prompt: PROMPT } = READS.voice_naming;

/** A voice group asks to be named during its conversation once it said this many words there (his word of 21 Nov 2026: during or after a meeting, never before). */
export const LIVE_GROUP_WORDS = 150;
/** The most voice naming calls on his day, the night's included: a runaway guard for the day's step. */
export const NAMINGS_A_DAY = 50;

/** The spoken conversations of the watcher's voice read, cut as the night cuts them (`exchangesOf`), each with whether lifelog closed every one of its conversations. */
export function recentConversationsOf(voice: RecentVoice) {
  const turns: SpokenTurn[] = voice.built
    .flatMap((b) =>
      (voice.turns.get(b.unit.id) ?? []).map((t) => ({
        ...t,
        conversation: b.unit.key,
      }))
    )
    .toSorted(
      (a, b) =>
        a.at.localeCompare(b.at) ||
        a.jobId.localeCompare(b.jobId) ||
        a.turnIndex - b.turnIndex
    );
  return exchangesOf(turns, CONVERSATION_ENDS_AFTER).map((c) => ({
    closed: c.every((t) => voice.closed.has(t.conversation)),
    ref: turnRef(c[0]?.jobId ?? "", c[0]?.turnIndex ?? 0, c[0]?.at ?? ""),
    turns: c,
  }));
}

/**
 * Whether a conversation still under way asks a naming read now: a voice group (a queue item) said `LIVE_GROUP_WORDS`
 * or more in it, and no stored naming line holds a turn of that group's voices (`asked`, `voiceOfKey` of its keys).
 */
export function isGroupDue(
  parts: SpokenPart[],
  queue: readonly NamingQueueItem[],
  asked: ReadonlySet<string>
) {
  const words = new Map<string, number>();
  for (const p of parts) {
    for (const [n, v] of p.voices.entries()) {
      const key = voiceKey(jobOf(p.keys[n] ?? ""), v.label);
      words.set(key, (words.get(key) ?? 0) + wordsOf(v.text));
    }
  }
  return queue.some((item) => {
    const here = item.voices
      .map((v) => voiceKey(v.jobId, v.speakerLabel))
      .filter((k) => words.has(k));
    return (
      here.reduce((n, k) => n + (words.get(k) ?? 0), 0) >= LIVE_GROUP_WORDS &&
      !here.some((k) => asked.has(k))
    );
  });
}

/**
 * The day's voice naming (his yes of 21 Nov 2026 to a third daytime model step), on the watcher's voice read: a
 * conversation holding a voice group is read when lifelog closed it (once per process: `examined`, its first turn's
 * ref), or, still under way, when a group is due (`isGroupDue`). A short one is read only when worth it
 * (`isWorthNaming`, on the chats of its own window first, so a conversation that is not costs no 90-day read). Asked
 * and stored exactly as the night's (`readVoiceNamingWork`, `voiceNaming`), within `NAMINGS_A_DAY`; skipped while a
 * run holds the memory lock. The night reads what this missed. Returns the calls made.
 */
export async function nameVoicesOnArrival(
  voice: RecentVoice,
  people: People,
  examined: Set<string>,
  where = READ_REPLIES
) {
  const queue = await readNamingQueue();
  const jobs = new Set(queue.flatMap((i) => i.voices.map((v) => v.jobId)));
  const recent = recentConversationsOf(voice);
  // Only conversations still read: the set never outgrows the voice read.
  for (const ref of examined) {
    if (!recent.some((c) => c.ref === ref)) {
      examined.delete(ref);
    }
  }
  const held = recent.filter(
    (c) => !examined.has(c.ref) && c.turns.some((t) => jobs.has(t.jobId))
  );
  if (held.length === 0) {
    return 0;
  }
  const asked = new Set(
    readRepliesSince(held[0]?.turns[0]?.at ?? "", where)
      .filter((l) => l.read === VOICE_NAMING_READ)
      .flatMap((l) =>
        l.messages.filter((k) => k.includes(" voice:")).map(voiceOfKey)
      )
  );
  const due: SpokenPart[][] = [];
  for (const c of held) {
    // biome-ignore lint/performance/noAwaitInLoops: a few conversations, one fetch of words each
    const parts = await spokenPartsOf(c.turns, people);
    if (c.closed) {
      examined.add(c.ref);
    }
    if (c.closed || isGroupDue(parts, queue, asked)) {
      due.push(parts);
    }
  }
  if (due.length === 0) {
    return 0;
  }
  const from = Math.min(...due.map((p) => Date.parse(p[0]?.at ?? "")));
  const { events } = await readWithPeople(
    new Date(from - PLANNED_WITHIN - CALL_SLACK)
  );
  const near = { direct: directChats(events, people.resolve), events, people };
  const worth = due.filter((parts) => isWorthNaming(parts, near));
  const left = NAMINGS_A_DAY - (await readCallsToday([PROMPT]));
  if (worth.length === 0 || left <= 0) {
    return 0;
  }
  const work = await readVoiceNamingWork({ parts: worth }, people, where);
  if (work.asked.length === 0 || isLocked()) {
    return 0;
  }
  const done = await voiceNaming(work, left, where);
  return done.calls;
}
