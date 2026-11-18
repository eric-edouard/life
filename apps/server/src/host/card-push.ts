import { join } from "node:path";
import { clock, daysBefore } from "../core/clock";
import { readJson, readLineCount, writeJson } from "../core/files";
import { count } from "../core/lists";
import { log } from "../core/log";
import { checksNow } from "../memory/checks";
import { DECISIONS } from "../memory/decisions";
import { CORRECTIONS, FACT_CHECK_ANSWERS } from "../memory/memory-files";
import { isLocked } from "../memory/memory-lock";
import { dayNow } from "../memory/zones";
import { WATCH } from "../sources/lifelog";
import { notifyPhone } from "../sources/lifelog-push";

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

/** Pushes what is new among the open cards since the last look, then remembers them; the first run (no state) pushes nothing. */
export async function pushNewCards(now = clock()) {
  const open = await checksNow();
  const today = dayNow(now);
  const before = readJson<Pushed>(PUSHED);
  const cutoff = daysBefore(today, FORGET_DAYS);
  const seen = Object.fromEntries([
    ...Object.entries(before?.seen ?? {}).filter(([, day]) => day > cutoff),
    ...open.map((c) => [c.pushId, today]),
  ]);
  // Written before the push, so one that fails is not repeated every look: the inbox and the badge still tell him.
  writeJson(PUSHED, { badge: open.length, seen } satisfies Pushed);
  if (!before) {
    return;
  }
  const fresh = open.filter((c) => !(c.pushId in before.seen));
  const [one] = fresh;
  if (!one) {
    if (open.length !== before.badge) {
      await notifyPhone({ badge: open.length });
    }
    return;
  }
  await notifyPhone({
    badge: open.length,
    body: `${count(fresh.length, "new card")}`,
    ...(fresh.length === 1 ? { card: one.pushId } : {}),
    quiet: fresh.every((c) => c.asker === "life"),
    title: "Life",
  });
}

/** What the last look saw of the files that change the open cards; empty before the first look, and after a night. */
let looked = "";
/**
 * The watcher's minute: `pushNewCards` only when the decisions, the corrections or his fact-check answers gained a
 * line, or a night ran, since the last look: never `checksNow` on every tick. (ponytail: a voice lifelog queues in the day waits for the next change or the night; add its queue's count to the look if that is too slow.) Not while a night holds the lock (its
 * writes are half done); its end shows as the next look.
 */
export async function pushNewCardsIfChanged() {
  if (isLocked()) {
    looked = "";
    return;
  }
  const now = [DECISIONS, CORRECTIONS, FACT_CHECK_ANSWERS]
    .map(readLineCount)
    .join();
  if (now === looked) {
    return;
  }
  looked = now;
  await pushNewCards().catch((e: Error) => {
    looked = "";
    log("run.error", { error: e.message, step: "watch.cards" });
  });
}
