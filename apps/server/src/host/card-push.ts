import { join } from "node:path";
import { clock, daysBefore } from "../core/clock";
import { readJson, readLineCount, writeJson } from "../core/files";
import { count } from "../core/lists";
import { log } from "../core/log";
import { checksNow, type InboxCheck, pushIdOf } from "../memory/checks";
import { DECISIONS, decisionsNow } from "../memory/decisions";
import { CORRECTIONS, FACT_CHECK_ANSWERS } from "../memory/memory-files";
import { isLocked } from "../memory/memory-lock";
import { dayNow } from "../memory/zones";
import { WATCH } from "../sources/lifelog";
import { notifyPhone } from "../sources/lifelog-push";
import { fetchNamingQueue } from "../sources/lifelog-voices";

// A push for each new card in his inbox, the only push of cards: the words "1 new card" or "N new cards", the badge (every
// open card) and, for one card, its `pushId` (an HMAC of its ref under a key that never leaves the Mac). Never a title,
// a question, a name or a ref: it goes through Apple (SECURITY.md, his yes of 18 Nov 2026). The phone matches the id
// against `read_inbox`. What was seen is a small state file of the watcher's, outside `memory/`.

export const PUSHED = join(WATCH, "pushed-cards.json");
/** A card not open for this many days is forgotten, so one that returns is new again. */
const FORGET_DAYS = 30;

interface Pushed {
  badge: number;
  /** Each card's `pushId` and the last day it was seen open. */
  seen: Record<string, string>;
}

type Open = Pick<InboxCheck, "asker" | "pushId">;

/**
 * Pushes what is new among `open` since the last look, then remembers it; the first run (no state) pushes nothing.
 * `total` is every open card (the badge); without it `open` holds only some kinds, and the badge grows by what is new.
 */
async function pushNew(open: Open[], total?: number, now = clock()) {
  const today = dayNow(now);
  const before = readJson<Pushed>(PUSHED);
  if (!(before || total !== undefined)) {
    return;
  }
  const cutoff = daysBefore(today, FORGET_DAYS);
  const fresh = open.filter((c) => !(c.pushId in (before?.seen ?? {})));
  const badge = total ?? (before?.badge ?? 0) + fresh.length;
  const seen = Object.fromEntries([
    ...Object.entries(before?.seen ?? {}).filter(([, day]) => day > cutoff),
    ...open.map((c) => [c.pushId, today]),
  ]);
  // Written before the push, so one that fails is not repeated every look: the inbox and the badge still tell him.
  writeJson(PUSHED, { badge, seen } satisfies Pushed);
  const [one] = fresh;
  if (!(before && one)) {
    if (before && badge !== before.badge) {
      await notifyPhone({ badge });
    }
    return;
  }
  await notifyPhone({
    badge,
    body: count(fresh.length, "new card"),
    ...(fresh.length === 1 ? { pushId: one.pushId } : {}),
    quiet: fresh.every((c) => c.asker === "life"),
    title: "Life",
  });
}

/** Pushes what is new among every open card (`checksNow`). */
export async function pushNewCards(now = clock()) {
  const open = await checksNow();
  await pushNew(open, open.length, now);
}

/** Pushes the new open decisions alone, from the decisions' lines: no `checksNow`, for while a run holds the memory lock. */
const pushNewDecisions = () =>
  pushNew(
    decisionsNow()
      .filter((d) => d.state === "open")
      .map((d) => ({ asker: d.asker, pushId: pushIdOf(d.id) }))
  );

/** What the last look saw of what changes the open cards; empty before the first look, and after a run held the lock. */
let looked = "";
let decisionsLooked = -1;
let voices = "";
/**
 * The watcher's minute: `pushNewCards` only when the decisions, the corrections, his fact-check answers or the voices
 * lifelog queues changed since the last look: never `checksNow` on every tick (the queue is one read of his own lifelog). A
 * run holding the memory lock (a night's writes are half done) is not read: only a new decision still pushes, from its
 * own lines; the run's end shows as the next full look.
 */
export async function pushNewCardsIfChanged() {
  const decisions = readLineCount(DECISIONS);
  const held = isLocked();
  const moved = decisions !== decisionsLooked;
  decisionsLooked = decisions;
  const failed = (e: Error) => {
    looked = "";
    log("run.error", { error: e.message, step: "watch.cards" });
  };
  if (held) {
    looked = "";
    if (moved) {
      await pushNewDecisions().catch(failed);
    }
    return;
  }
  // lifelog down: the last list stands, and nothing is logged for it every minute.
  voices = await fetchNamingQueue()
    .then((q) => q.map((v) => v.id).join(" "))
    .catch(() => voices);
  const now = [
    decisions,
    readLineCount(CORRECTIONS),
    readLineCount(FACT_CHECK_ANSWERS),
    voices,
  ].join();
  if (now === looked) {
    return;
  }
  looked = now;
  await pushNewCards().catch(failed);
}
