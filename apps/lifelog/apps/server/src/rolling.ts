// When summaries roll (intelligence.ts makes the runs). One rule: a live conversation grouped
// here, of talk, is due when its words differ from what its last finished roll read
// (`conversations.turns_fp`), or it closed since. However late its words came (held audio, credits
// out, the phone offline), it rolls once they are there, window after window, until they are
// covered; then its fingerprint is kept. A roll that waits (the Mac left) leaves it due, so the next
// drain resumes it; one that failed is tried again after a backoff, at most once an hour. A drain
// looks only at what the change log touched since the last one, and at what was left due. The
// owner's Generate rolls it again from its first turn; the summary shown stays until a newer valid
// run replaces it. Only the Mac runs a roll (its subscription); nothing here reaches a paid API.

import type { Db } from "@lifelog/db";
import { conversations, intelligenceRuns, isSettled } from "@lifelog/db/schema";
import { desc, eq } from "drizzle-orm";
import type { Nudge } from "./apns";
import { touchedSince } from "./change-log";
import { singleFlight } from "./config";
import { type Retries, requestRoll } from "./intelligence";
import type { Provider } from "./providers";
import { dueConversations, fingerprint, type Run, splitsOf } from "./summaries";
import { PROMPT_VERSION, Result } from "./summary-calls";
import { switches } from "./switches";

// What a roll reads past the closed chapters: about 20 minutes of talk, some 6k tokens.
const WINDOW_CHARS = 24_000;
// Conversations a drain rolls at once. Their calls share the Mac's MAC_SLOTS (mac-socket.ts); this
// only keeps a backlog from starting every run at once. ponytail: fixed.
const AT_ONCE = 3;

// Rolls a conversation window after window, `settled` after each run, the first from its first
// turn when `fromScratch`. True once its words are covered; false while it can't go on (the Mac
// away, a run in flight, one that waits or failed): it stays due.
async function rollWindows(
  db: Db,
  mac: Provider,
  id: string,
  options: Parameters<typeof requestRoll>[3],
  settled: (run: Run) => Promise<void>
) {
  for (let first = true; ; first = false) {
    const started = requestRoll(db, mac, id, {
      ...options,
      fromScratch: options.fromScratch && first,
    });
    if (started === null) {
      return true;
    }
    if (started === "busy") {
      return false;
    }
    // biome-ignore lint/performance/noAwaitInLoops: one window after the other
    const { more, run } = await started.work;
    if (run.state === "waiting" || run.state === "failed") {
      return false;
    }
    await settled(run);
    if (!more) {
      return true;
    }
  }
}

// A valid roll that found a confident new conversation.
const splitOff = (run: Run) =>
  run.state === "valid" &&
  splitsOf(Result.safeParse(run.result).data, run.turns, "high").length > 0;

export function rollingChapters(
  db: Db,
  {
    mac,
    nudge = () => Promise.resolve(),
    retries,
    windowChars = WINDOW_CHARS,
  }: {
    mac: Provider | null;
    nudge?: Nudge;
    // Tests ask again without waiting; the server waits `requestRoll`'s backoff.
    retries?: Retries;
    windowChars?: number;
  }
) {
  // Conversations the owner's Generate asked for, rolled from the first turn on their next round.
  const asked = new Set<string>();

  // Rolls one conversation until its words are covered, then keeps what it read. Generate: every
  // chapter closes.
  const once = async (id: string) => {
    const generate = asked.delete(id);
    const conversation = db.query.conversations
      .findFirst({
        where: (c, { eq: is }) => is(c.id, id),
      })
      .sync();
    if (!(mac && conversation) || conversation.retiredAt !== null) {
      return;
    }
    const fp = fingerprint(db, id);
    const open = !(generate || isSettled(conversation));
    const covered = await rollWindows(
      db,
      mac,
      id,
      { fromScratch: generate, open, retries, windowChars },
      async (run) => {
        if (run.state === "valid") {
          // The phone collects it now.
          await nudge("summary", { conversation: id });
        }
        if (splitOff(run)) {
          // Not awaited: this conversation's own roll is the one running.
          drain();
        }
      }
    );
    if (covered) {
      db.update(conversations)
        .set({ turnsFp: fp })
        .where(eq(conversations.id, id))
        .run();
    }
  };

  // At most one roll per conversation: a request while one runs makes it roll once more after.
  const roll = singleFlight((id: string) =>
    once(id).catch((error: unknown) =>
      console.error(`rolling ${id}: ${String(error)}`)
    )
  );

  const able = () => mac !== null && mac.ready?.() !== false;

  // The change log read through (null: nothing read yet, so every conversation is looked at), and
  // the conversations left due (the Mac away, a failed roll's backoff), looked at again each time.
  let cursor: number | null = null;
  const due = new Set<string>();
  // The due conversations whose roll may start now, newest first.
  function check() {
    const touched = touchedSince(db, cursor);
    const ids = touched.ids && [...new Set([...touched.ids, ...due])];
    const rows = dueConversations(db, ids);
    for (const id of ids ?? [...due]) {
      due.delete(id);
    }
    for (const r of rows) {
      due.add(r.id);
    }
    cursor = touched.through;
    return rows.filter((r) => !r.later).map((r) => r.id);
  }

  // Every due conversation, a few at a time, while summaries are on and the Mac is there (it woke, a
  // source was grouped, every 5 minutes). Without it, a drain only updates what is due (`GET /status` counts
  // it). One drain at a time; a call while one runs makes it go round again. ponytail: what is due
  // is worked out every tick even with the Mac away (the change log since the last drain, and what
  // was left due); skip it while away if that pass ever shows in a profile.
  const draining = singleFlight(async () => {
    // Summaries off (switches.ts): nothing is due, and once on, the next drain looks at every
    // conversation again.
    if (!switches().ai) {
      cursor = null;
      due.clear();
      return;
    }
    const ready = check();
    for (let i = 0; i < ready.length && able(); i += AT_ONCE) {
      // biome-ignore lint/performance/noAwaitInLoops: a few conversations at a time
      await Promise.all(ready.slice(i, i + AT_ONCE).map((id) => roll(id)));
    }
  });
  const drain = (): Promise<void> =>
    draining().catch((error: unknown) =>
      console.error(`rolling: ${String(error)}`)
    );

  return {
    drain,
    // The conversations whose summary is due or waits, as the last drain found them.
    due: () => [...due],
    // The owner's Generate: it rolls from its first turn, every chapter closing; the summary shown
    // stays until the new run is valid. With the Mac away a run waits for it (the next drain takes
    // it, from the first turn too).
    generate(id: string) {
      if (!mac) {
        return;
      }
      db.transaction((tx) => {
        tx.update(conversations)
          .set({ turnsFp: null })
          .where(eq(conversations.id, id))
          .run();
        const latest = tx
          .select({ state: intelligenceRuns.state })
          .from(intelligenceRuns)
          .where(eq(intelligenceRuns.conversationId, id))
          .orderBy(desc(intelligenceRuns.createdAt))
          .limit(1)
          .get();
        if (!able() && latest?.state !== "waiting") {
          tx.insert(intelligenceRuns)
            .values({
              conversationId: id,
              model: mac.model,
              promptVersion: PROMPT_VERSION,
              provider: mac.name,
              state: "waiting",
              turns: [],
            })
            .run();
        }
      });
      asked.add(id);
      roll(id);
    },
    // Tests: resolves once nothing rolls.
    idle: () => Promise.all([roll.idle(), draining.idle()]),
  };
}
export type Rolling = ReturnType<typeof rollingChapters>;
