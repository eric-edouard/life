// The sends at ElevenLabs at once, at most ELEVENLABS_SLOTS: the submitted jobs it may still be
// working on (`atScribe`, read each time) and the sends this process has under way, each counted once
// by its key (a job keeps its id from its send to its webhook, so its row taking over its slot never
// counts it twice). `send` is the one way to Scribe: a slot first, then the caller's claim records the
// send, then the POST; reading audio and the speech service take none. Dictation ("interactive")
// waits ahead of everything else, each priority in arrival order; a send under way is never cut.
// Every wait is bounded, and one aborted leaves the line at once.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import { transcriptionJobs as jobs } from "@lifelog/db/schema";
import { and, eq, gt, isNull, or } from "drizzle-orm";

// A send not answered after this was lost by ElevenLabs if it no longer knows it; until then it
// counts as one of the transcriptions running there.
export const LOST_AFTER_MS = 30 * 60 * 1000;

// The submitted jobs ElevenLabs may still be working on, each holding one of its slots until it is
// settled: a Scribe send it knows by a transcription id for LOST_AFTER_MS from its POST (then it was
// lost), one without (a POST cut off before its answer was stored, a 202 without ids) and any send
// that may have been billed (a routed excerpt under way, one cut off by a restart). A block heard
// at the speech service holds none.
export const atScribe = (db: Db) =>
  db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.state, "submitted"),
        or(
          eq(jobs.maybeBilled, true),
          and(
            eq(jobs.transcriber, "scribe"),
            or(
              isNull(jobs.providerTranscriptionId),
              gt(
                jobs.requestSentAt,
                new Date(clock().getTime() - LOST_AFTER_MS)
              )
            )
          )
        )
      )
    )
    .all()
    .map((job) => job.id);

export type Priority = "interactive" | "ordinary";
type Release = () => void;
// Why a send did not go: nothing was claimed or sent.
export interface Unsent {
  unsent: string;
}
interface Wait {
  priority: Priority;
  signal?: AbortSignal;
  waitMs: number;
}
interface Waiter {
  grant: (release: Release | null) => void;
  key: string;
  priority: Priority;
}

// `onFree` runs when a slot may have come free and nobody waits: the job worker then sends what is
// queued.
export function scribeSlots(
  size: number,
  submitted: () => string[],
  onFree: () => void = () => undefined
) {
  const sending = new Set<string>();
  const line: Waiter[] = [];

  const free = () => size - new Set([...submitted(), ...sending]).size;

  function grant() {
    while (line.length > 0 && free() > 0) {
      const next = line.shift() as Waiter;
      next.grant(hold(next.key));
    }
  }

  // Grants the free slots to the line, in its order, then tells the worker of any left.
  function wake() {
    grant();
    if (line.length === 0 && free() > 0) {
      onFree();
    }
  }

  function hold(key: string): Release {
    sending.add(key);
    let held = true;
    return () => {
      if (held) {
        held = false;
        sending.delete(key);
        wake();
      }
    };
  }

  function wait(
    key: string,
    { priority, signal, waitMs }: Wait
  ): Promise<Release | null> {
    if (signal?.aborted) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const leave = () => {
        const at = line.indexOf(waiter);
        if (at >= 0) {
          line.splice(at, 1);
          waiter.grant(null);
        }
      };
      const timer = setTimeout(leave, waitMs);
      const waiter: Waiter = {
        grant(release) {
          clearTimeout(timer);
          signal?.removeEventListener("abort", leave);
          resolve(release);
        },
        key,
        priority,
      };
      signal?.addEventListener("abort", leave);
      const behind =
        priority === "interactive"
          ? line.findIndex((w) => w.priority === "ordinary")
          : -1;
      line.splice(behind < 0 ? line.length : behind, 0, waiter);
      grant();
    });
  }

  return {
    // The slots a queued job may take now: none while anyone waits.
    room() {
      grant();
      return line.length > 0 ? 0 : Math.max(0, free());
    },
    // One paid send, `key` unique per send (a job's id). With a slot (none within `waitMs`, or an
    // abort first: unsent), `claim` decides synchronously and records the send (a reason: unsent),
    // then `post` sends it and settles its answer. The slot is held until `post` ends, and released
    // on an abort, a refusal or a throw before it.
    async send<T>(
      key: string,
      until: Wait,
      claim: () => string | null,
      post: () => Promise<T>
    ): Promise<T | Unsent> {
      const release = await wait(key, until);
      if (!release) {
        return {
          unsent: until.signal?.aborted
            ? "canceled"
            : "no Scribe slot came in time",
        };
      }
      try {
        if (until.signal?.aborted) {
          return { unsent: "canceled" };
        }
        const why = claim();
        return why ? { unsent: why } : await post();
      } finally {
        release();
      }
    },
    // A submitted job may have been settled (a webhook, reconcile, a stored answer).
    wake,
  };
}
