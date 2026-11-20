import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { clock, daysBefore, HOUR } from "../core/clock";
import { readJson, readLineCount, writeJson } from "../core/files";
import { count } from "../core/lists";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import type { NotifyKind, NotifyLevel } from "../core/names";
import { settings } from "../core/settings";
import { blockingCountOf } from "../memory/check-urgency";
import { type InboxCheck, pushIdOf } from "../memory/checks";
import { DECISIONS, decisionsNow } from "../memory/decisions";
import type { StoredDraft } from "../memory/draft";
import { isLocked } from "../memory/memory-lock";
import { dayNow } from "../memory/zones";
import { WATCH } from "../sources/lifelog";
import {
  notifyPhone,
  type Push,
  type PushLevel,
} from "../sources/lifelog-push";
import { openChecksNow } from "./inbox";

// A push for each new card in his inbox, of every kind, the only push of cards (his answers of 19 Nov 2026): the words
// "1 new card" (past the first 5 of Life's own checks in one look, one "N more new cards"), the badge (what blocks him),
// its level (his `notifications` setting for its kind) and, for one card, its `pushId` (an HMAC of its ref under a key
// that never leaves the Mac). Never a title, a question, a name or a ref: it goes through Apple (SECURITY.md). The
// phone reads the card from `read_inbox` and writes the notification's text. A card that left his inbox (answered
// anywhere, withdrawn, lapsed) goes as its `pushId` in a background push, and the phone removes its notification. What
// was seen is a small state file of the watcher's, outside `memory/`.

export const SEEN = join(WATCH, "seen-cards.json");
/** A card not open for this many days is forgotten, so one that returns is new again. */
const FORGET_DAYS = 30;
/** Of Life's own checks new in one look, how many push alone; the rest share one push. An agent's decision always pushes alone. */
const ALONE = 5;
/** Life's level for a kind he left out of `notifications`: full push, an agent's decision urgent. */
export const NOTIFY_DEFAULTS: Record<NotifyKind, NotifyLevel> = {
  "contacts card": "normal",
  decision: "urgent",
  "decision with a draft": "urgent",
  ending: "normal",
  "guessed person": "normal",
  name: "normal",
  "new matter": "normal",
  voice: "normal",
};
const URGENT_WITHIN = 3 * HOUR;

/** The most `pushId`s one removal push carries: Apple's 4 KB payload. */
const REMOVED_MAX = 100;

interface Seen {
  badge: number;
  /** The `pushId`s open at the last whole look (`total` given): one gone since is removed from his phone. */
  open?: string[];
  /** Each card's `pushId` and the last day it was seen open. */
  seen: Record<string, string>;
}

type Open = Pick<InboxCheck, "deadline" | "group" | "pushId"> & {
  draft?: StoredDraft | null;
};

/** The kind his notification settings name a card by. */
export const notifyKindOf = (c: Pick<Open, "draft" | "group">): NotifyKind =>
  c.draft ? "decision with a draft" : c.group;

/** The push's level for a card at `setting`: urgent is time-sensitive with no deadline or within 3 hours of it. */
export const levelOf = (
  setting: Exclude<NotifyLevel, "off">,
  deadline: string | null,
  now: Date
): PushLevel => {
  if (setting === "quiet") {
    return "passive";
  }
  const due =
    deadline === null || Date.parse(deadline) - now.getTime() <= URGENT_WITHIN;
  return setting === "urgent" && due ? "time-sensitive" : "active";
};

const LOUDNESS: PushLevel[] = ["passive", "active", "time-sensitive"];
const loudest = (levels: PushLevel[]) =>
  LOUDNESS[Math.max(...levels.map((l) => LOUDNESS.indexOf(l)))] ?? "active";

/**
 * Pushes what is new among `open` (in his inbox's order) since the last look, then remembers it; the first run (no
 * state) pushes nothing. `total` is every open card (the badge), and what was open at the last whole look and is not
 * now is removed from his phone; without it `open` holds only some kinds, the badge grows by what is new, and nothing
 * is removed.
 */
async function pushNew(open: Open[], total?: number, now = clock()) {
  const today = dayNow(now);
  const before = readJson<Seen>(SEEN);
  if (!(before || total !== undefined)) {
    return;
  }
  const cutoff = daysBefore(today, FORGET_DAYS);
  const badge =
    total ??
    (before?.badge ?? 0) +
      open.filter((c) => !(c.pushId in (before?.seen ?? {}))).length;
  const seen = Object.fromEntries([
    ...Object.entries(before?.seen ?? {}).filter(([, day]) => day > cutoff),
    ...open.map((c) => [c.pushId, today]),
  ]);
  const looked = total === undefined ? before?.open : open.map((c) => c.pushId);
  const next: Seen = { badge, ...(looked ? { open: looked } : {}), seen };
  // Written before the push, so one that fails is not repeated every look: the inbox and the badge still tell him.
  if (!isDeepStrictEqual(before, next)) {
    writeJson(SEEN, next);
  }
  if (!before) {
    return;
  }
  const removed =
    total === undefined
      ? []
      : (before.open ?? []).filter((id) => !looked?.includes(id));
  // ponytail: past REMOVED_MAX at once, the phone's next whole read of the inbox removes the rest.
  if (removed.length > 0) {
    await notifyPhone({ removed: removed.slice(0, REMOVED_MAX) });
  }
  const levels = settings().notifications;
  const fresh = open.flatMap((c) => {
    const kind = notifyKindOf(c);
    const setting = levels[kind] ?? NOTIFY_DEFAULTS[kind];
    return c.pushId in before.seen || setting === "off"
      ? []
      : [{ ...c, level: levelOf(setting, c.deadline, now) }];
  });
  const others = fresh.filter((c) => c.group !== "decision");
  const rest = others.slice(ALONE);
  const alone = [
    ...fresh.filter((c) => c.group === "decision"),
    ...others.slice(0, ALONE),
  ];
  if (fresh.length === 0 && badge !== before.badge) {
    await notifyPhone({ badge });
  }
  const pushes: Push[] = alone.map((c) => ({
    body: "1 new card",
    level: c.level,
    pushId: c.pushId,
  }));
  if (rest.length > 0) {
    pushes.push({
      body: count(rest.length, "more new card"),
      level: loudest(rest.map((c) => c.level)),
    });
  }
  await pushInOrder(pushes, badge, rest.length);
}

/**
 * One at a time, in his inbox's order: the phone shows them as they come. Each one lifelog took is a
 * `card.push_accepted` line (lifelog may still skip Apple): a card's by its push id, the rest by count.
 */
async function pushInOrder(pushes: Push[], badge: number, rest: number) {
  for (const p of pushes) {
    // biome-ignore lint/performance/noAwaitInLoops: in his inbox's order
    if (await notifyPhone({ badge, title: "Life", ...p })) {
      log("card.push_accepted", {
        cards: p.pushId ? 1 : rest,
        loudness: p.level,
        ...(p.pushId ? { pushId: p.pushId } : {}),
      });
    }
  }
}

/** Pushes what is new in his inbox; the badge counts what blocks him (`blockingCountOf`). */
export async function pushNewCards(now = clock()) {
  const open = await openChecksNow();
  await pushNew(open, blockingCountOf(open), now);
}

/** Pushes the new open decisions alone, from the decisions' lines: no `checksNow`, for while a run holds the memory lock. */
const pushNewDecisions = () =>
  pushNew(
    decisionsNow()
      .filter((d) => d.state === "open")
      .map((d) => ({
        deadline: d.deadline,
        draft: d.draft,
        group: "decision" as const,
        pushId: pushIdOf(d.id),
      }))
  );

let decisionsLooked = -1;

/** Every few seconds: a new decision line pushes at once, whoever asked it (his approval to send is waited on), never a minute later. */
export function pushNewDecisionsAtOnce() {
  if (readLineCount(DECISIONS) !== decisionsLooked) {
    pushNewCardsIfChanged();
  }
}

/**
 * The watcher's minute: `pushNewCards`, whose inbox is read again only when what it is read from changed (`checksNow`),
 * a run's end, a desk start and a new day included. A run holding the memory lock (a night's writes are half done) is not
 * read: only a new decision still pushes, from its own lines; the run's end shows as the next full look.
 */
export async function pushNewCardsIfChanged() {
  const decisions = readLineCount(DECISIONS);
  const moved = decisions !== decisionsLooked;
  decisionsLooked = decisions;
  const failed = (e: Error) =>
    log("run.error", { ...errorOf(e), step: "watch.cards" });
  if (isLocked()) {
    if (moved) {
      await pushNewDecisions().catch(failed);
    }
    return;
  }
  await pushNewCards().catch(failed);
}
