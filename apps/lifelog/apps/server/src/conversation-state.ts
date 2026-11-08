// Where each live conversation stands, and why it waits: the one rule (rebuild contract, "Decisions
// after the independent review"). The feed carries both from the row; the phone adds only "Not
// uploaded yet" from its own blocks.
// - state: with words, transcribing while more of its audio is out, else summarized once a summary is valid, else transcribed;
//   without words, transcribing once its audio is sent, uploaded while it waits to be, failed when
//   transcription gave up on it, else transcribed (nothing to transcribe).
// - waiting: its audio waiting while transcription is off or credits are out; audio past a stuck Mac watermark
//   (`macAway`); the phone quiet while the Pendant records (`phoneQuiet`); its summary waiting for
//   AI to be switched on or for the Mac. Imported recordings wait for nothing.
// A pass recomputes the conversations the change log touched since the last one, the open ones
// (phoneQuiet follows the clock), and all of them when a switch, the credits, the Mac or the
// recording changed; the first pass after a start does all. Rows that change are written and
// logged.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  type ConversationState,
  conversations,
  holdsTurn,
  settled,
  touchesJob,
  unfinishedJobStates,
  type waitingReasons,
  waitsForCredits,
} from "@lifelog/db/schema";
import { sql } from "drizzle-orm";
import { logChange, touchedSince } from "./change-log";
import { latestHeartbeat, pendantRecords } from "./diagnostics";
import { summaryDue } from "./summaries";
import { switches } from "./switches";

type Reason = (typeof waitingReasons)[number];

// Heard-through this far behind, and before a conversation's end, while the Pendant records: the
// phone isn't sending its audio. A conversation with every word heard waits for nothing of it.
const STALLED_MS = 10 * 60_000;
// Keeps `in (…)` valid with nothing touched.
const NO_ID = "00000000-0000-0000-0000-000000000000";

export interface Facts {
  // Some of its audio: out (queued or sent, or a speech fragment whose block is still open), sent,
  // given up on.
  busy: boolean;
  due: boolean;
  failed: boolean;
  // Some of its audio waits for ElevenLabs credits (the speech service heard it; `waitsForCredits`).
  for_credits: boolean;
  id: string;
  imported: boolean;
  mac_held: boolean;
  open: boolean;
  reason: Reason | null;
  sent: boolean;
  stalled: boolean;
  state: ConversationState;
  summarized: boolean;
  words: boolean;
}

export function stateOf(f: Facts): ConversationState {
  if (f.words) {
    if (f.busy) {
      return "transcribing";
    }
    return f.summarized ? "summarized" : "transcribed";
  }
  if (f.sent) {
    return "transcribing";
  }
  if (f.busy) {
    return "uploaded";
  }
  return f.failed ? "failed" : "transcribed";
}

// What a conversation's wait depends on beyond its own row.
export interface World {
  ai: boolean;
  creditsOut: boolean;
  macAble: boolean;
  recording: boolean;
  transcription: boolean;
}

// While some of its audio waits to be transcribed.
const audioWait = (f: Facts, w: World): Reason | null => {
  if (!w.transcription) {
    return "transcriptionOff";
  }
  return w.creditsOut || f.for_credits ? "creditsOut" : null;
};

// Why summaries wait now, whichever conversation (`GET /status` `pipeline.ai.blockedBy` says it too).
// Off (the default), none is coming, so none waits.
export const summaryWaits = ["macAway"] as const;
export const summaryWait = (
  w: Pick<World, "ai" | "macAble">
): (typeof summaryWaits)[number] | null =>
  w.ai && !w.macAble ? "macAway" : null;

export function waitingOf(f: Facts, w: World): Reason | null {
  if (f.imported) {
    return null;
  }
  if (f.busy) {
    return audioWait(f, w);
  }
  if (f.mac_held) {
    return "macAway";
  }
  if (f.open && f.stalled && w.recording) {
    return "phoneQuiet";
  }
  // An open conversation always has chapters to come; a closed one while it is due.
  return f.words && (f.open || f.due) ? summaryWait(w) : null;
}

export interface Inputs {
  creditsOut: () => boolean;
  macAble: () => boolean;
  macStuckSince: () => Date | null;
}

export function conversationStates(db: Db, inputs: Inputs) {
  // The change log read through; null until the first pass, which does every live conversation.
  let cursor: number | null = null;
  // A switch, the credits, the Mac or the recording changed: every conversation again.
  let lastInputs = "";
  const all = (key: string) => cursor === null || key !== lastInputs;

  function pass(now: Date) {
    const on = switches();
    const recording = pendantRecords(latestHeartbeat(db));
    const stuck = inputs.macStuckSince();
    const creditsOut = inputs.creditsOut();
    const macAble = inputs.macAble();
    const key = JSON.stringify([on, recording, stuck, creditsOut, macAble]);
    const touched = touchedSince(db, all(key) ? null : cursor);
    // The jobs of its source over it, in some state.
    const jobIn = (...states: string[]) =>
      sql`exists (select 1 from transcription_jobs j where j.source_id = c.source_id
        and ${touchesJob()} and j.state in (${sql.join(
          states.map((state) => sql`${state}`),
          sql`, `
        )}))`;
    const rows = db.all<Record<keyof Facts, unknown>>(sql`
      select c.id, c.state, c.waiting_reason as reason, c.kind = 'imported' as imported,
        not ${settled()} as open,
        coalesce(s.heard_through < ${now.getTime() - STALLED_MS}
          and s.heard_through < c.capture_ended_at, 1) as stalled,
        coalesce(c.capture_ended_at > ${stuck?.getTime() ?? null}, 0) as mac_held,
        ${jobIn(...unfinishedJobStates)}
          or exists (select 1 from speech_fragments f where f.source_id = c.source_id
            and f.object_key is not null and ${touchesJob("c", "f")}) as busy,
        ${jobIn("submitted")} as sent, ${jobIn("failed")} as failed,
        exists (select 1 from transcription_jobs j where j.source_id = c.source_id
          and ${touchesJob()} and ${waitsForCredits("j")}) as for_credits,
        exists (select 1 from turns t where ${holdsTurn()}) as words,
        exists (select 1 from intelligence_runs r
          where r.conversation_id = c.id and r.state = 'valid') as summarized,
        ${summaryDue(db)} as due
      from conversations c
      left join sources s on s.id = c.source_id
      where c.retired_at is null and (${
        touched.ids
          ? sql`not ${settled()} or c.id in (${sql.join(
              [...touched.ids, NO_ID].map((id) => sql`${id}`),
              sql`, `
            )})`
          : sql`1`
      })`);
    const world: World = {
      ai: on.ai,
      creditsOut,
      macAble,
      recording,
      transcription: on.transcription,
    };
    // SQLite answers its flags as 0 and 1; every number here is one.
    const facts = rows.map(
      (r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => [
            k,
            typeof v === "number" ? v !== 0 : v,
          ])
        ) as unknown as Facts
    );
    const changed = facts.flatMap((f) => {
      const [state, reason] = [stateOf(f), waitingOf(f, world)];
      return state === f.state && reason === f.reason
        ? []
        : [{ id: f.id, reason, sinceKept: reason === f.reason, state }];
    });
    if (changed.length > 0) {
      db.transaction((tx) => {
        for (const c of changed) {
          tx.update(conversations)
            .set({
              state: c.state,
              waitingReason: c.reason,
              ...(c.sinceKept ? {} : { waitingSince: c.reason ? now : null }),
            })
            .where(sql`${conversations.id} = ${c.id}`)
            .run();
        }
        logChange(
          tx,
          "conversation",
          changed.map((c) => c.id)
        );
      });
    }
    cursor = touched.through;
    lastInputs = key;
  }

  // A pass is synchronous: nothing else runs while it does.
  return { refresh: (now = clock()) => pass(now) };
}

export type ConversationStates = ReturnType<typeof conversationStates>;
