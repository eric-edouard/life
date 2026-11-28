import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { clock, daysBefore, HOUR } from "../core/clock";
import { readJson, readLineCount, writeJson } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { blockingCountOf } from "../memory/check-urgency";
import type { InboxCheck } from "../memory/checks";
import { deliveryOf } from "../memory/decision-delivery";
import { DECISIONS } from "../memory/decision-lines";
import { decisionsNow } from "../memory/decisions";
import { draftsOf, type StoredDraft } from "../memory/draft";
import { instructionsFor } from "../memory/instructions";
import { isLocked } from "../memory/memory-lock";
import { cardSubjectOf } from "../memory/who";
import { dayNow } from "../memory/zones";
import { WATCH } from "../sources/lifelog";
import {
  notifyPhone,
  type Push,
  type PushLevel,
  pushIdOf,
} from "../sources/lifelog-push";
import { inboxChecksNow } from "./inbox";

// A push for each agent's card the gate delivers, once, the only push of cards (the v4 plan, bundle E; Life's own checks
// wait in the list and push nothing, his yes of 25 Nov 2026, question 18): the words "1 new card", the badge (what
// blocks him), its level (`pushLevelOf`) and its `pushId` (an HMAC of its ref under a key that never leaves the Mac).
// Never a title, a question, a name or a ref: it goes through Apple (SECURITY.md). The
// phone reads the card from `read_inbox` and writes the notification's text. A card that left his inbox (answered
// anywhere, withdrawn, lapsed) goes as its `pushId` in a background push, and the phone removes its notification. What
// was seen is a small state file of the watcher's, outside `memory/`. A card notifies once per subject (`cardSubjectOf`):
// one whose ref changes with its question (a voice card's suggested person) is new to the inbox, never to his phone.

export const SEEN = join(WATCH, "seen-cards.json");
/** A card not open for this many days is forgotten, so one that returns is new again. */
const FORGET_DAYS = 30;
/** How near its deadline a card's push is time-sensitive (iOS lets one through a Focus): the only time it is. */
const URGENT_WITHIN = 3 * HOUR;

/** The most `pushId`s one removal push carries: Apple's 4 KB payload. */
const REMOVED_MAX = 100;

interface Seen {
  badge: number;
  /** The `pushId`s open at the last whole look (`total` given): one gone since is removed from his phone. */
  open?: string[];
  /** Each card's `pushId` and its subject's (`subjectIdOf`), and the last day it was seen open. */
  seen: Record<string, string>;
}

type Open = Pick<InboxCheck, "deadline" | "group" | "pushId" | "ref"> & {
  draft?: StoredDraft | null;
  drafts?: StoredDraft[];
  matter?: { id: string } | null;
};

/** The id a card's subject is seen under: its `pushId` when the subject is its ref. */
const subjectIdOf = (c: Open) => {
  const subject = cardSubjectOf(c.ref);
  return subject === c.ref ? c.pushId : pushIdOf(subject);
};
const isSeen = (c: Open, seen: Seen["seen"]) =>
  c.pushId in seen || subjectIdOf(c) in seen;

/** The open cards the gate has not read yet (`pending`), and those it delivered never to push (`silent`, a sensitive subject). */
function gateStatesOf(now: Date) {
  const states = decisionsNow(now)
    .filter((d) => d.state === "open")
    .map((d) => [d.id, deliveryOf(d, now)] as const);
  return {
    pending: new Set(
      states.flatMap(([id, x]) => (x.state === "pending" ? [id] : []))
    ),
    silent: new Set(
      states.flatMap(([id, x]) =>
        x.state === "delivered" && x.silent ? [id] : []
      )
    ),
  };
}

/** His instructions in force on a card: its matter's, its drafts' chats' and channels', and everything's. */
export const cardInstructionsOf = (c: {
  drafts: readonly Pick<StoredDraft, "channel" | "chat">[];
  matter?: string | null;
}) =>
  instructionsFor({
    channels: c.drafts.flatMap((d) =>
      [d.channel, d.chat].filter((x): x is string => Boolean(x))
    ),
    matter: c.matter ?? undefined,
  });

/**
 * A delivered card's push, the one rule: time-sensitive within 3 hours of its deadline; else raised by an `interrupt`
 * instruction on it, lowered by a `quiet` one (a refusal beats a grant), active otherwise.
 */
export function pushLevelOf(
  c: { deadline: string | null },
  effects: readonly (string | undefined)[],
  now: Date
): PushLevel {
  if (
    c.deadline !== null &&
    Date.parse(c.deadline) - now.getTime() <= URGENT_WITHIN
  ) {
    return "time-sensitive";
  }
  if (effects.includes("quiet")) {
    return "passive";
  }
  return effects.includes("interrupt") ? "time-sensitive" : "active";
}

/**
 * Pushes what is new among `open` (in his inbox's order) since the last look, then remembers it; the first run (no
 * state) pushes nothing. `total` is every open card (the badge), and what was open at the last whole look and is not
 * now is removed from his phone; without it `open` holds only some kinds, the badge grows by what is new, and nothing
 * is removed.
 */
async function pushNew(open: Open[], total?: number, now = clock()) {
  const { silent } = gateStatesOf(now);
  const today = dayNow(now);
  const before = readJson<Seen>(SEEN);
  if (!(before || total !== undefined)) {
    return;
  }
  const cutoff = daysBefore(today, FORGET_DAYS);
  const badge =
    total ??
    (before?.badge ?? 0) +
      open.filter((c) => !isSeen(c, before?.seen ?? {})).length;
  const seen = Object.fromEntries([
    ...Object.entries(before?.seen ?? {}).filter(([, day]) => day > cutoff),
    ...open.flatMap((c) => [
      [c.pushId, today],
      [subjectIdOf(c), today],
    ]),
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
  const pushes: Push[] = open.flatMap((c) =>
    c.group !== "decision" || isSeen(c, before.seen) || silent.has(c.ref)
      ? []
      : [
          {
            body: "1 new card",
            level: pushLevelOf(
              c,
              cardInstructionsOf({
                drafts: draftsOf(c),
                matter: c.matter?.id,
              }).map((i) => i.effect),
              now
            ),
            pushId: c.pushId,
          },
        ]
  );
  if (pushes.length === 0 && badge !== before.badge) {
    await notifyPhone({ badge });
  }
  await pushInOrder(pushes, badge);
}

/**
 * One at a time, in his inbox's order: the phone shows them as they come. Each one lifelog took is a
 * `card.push_accepted` line (lifelog may still skip Apple), by its push id.
 */
async function pushInOrder(pushes: Push[], badge: number) {
  for (const p of pushes) {
    // biome-ignore lint/performance/noAwaitInLoops: in his inbox's order
    if (await notifyPhone({ badge, title: "Life", ...p })) {
      log("card.push_accepted", { loudness: p.level, pushId: p.pushId });
    }
  }
}

/** Pushes what is new in his inbox; the badge counts what blocks him (`blockingCountOf`). */
export async function pushNewCards(now = clock()) {
  // A card the gate has not read yet is neither seen nor counted: it pushes once delivered.
  const { pending } = gateStatesOf(now);
  const open = (await inboxChecksNow()).filter((c) => !pending.has(c.ref));
  await pushNew(open, blockingCountOf(open), now);
}

/** Pushes the new open decisions alone, from the decisions' lines: no `checksNow`, for while a run holds the memory lock. */
const pushNewDecisions = () =>
  pushNew(
    decisionsNow()
      .filter((d) => d.state === "open" && deliveryOf(d).state !== "pending")
      .map((d) => ({
        deadline: d.deadline,
        drafts: d.drafts,
        group: "decision" as const,
        matter: d.matter ? { id: d.matter } : null,
        pushId: pushIdOf(d.id),
        ref: d.id,
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
 * read: only a new open decision still pushes, from the decisions' lines; the run's end shows as the next full look.
 */
export async function pushNewCardsIfChanged() {
  decisionsLooked = readLineCount(DECISIONS);
  const failed = (e: Error) =>
    log("run.error", { ...errorOf(e), step: "watch.cards" });
  // Every minute, not only on a new line: a waiting card that opens after `CONTEST_WAIT` writes none.
  if (isLocked()) {
    await pushNewDecisions().catch(failed);
    return;
  }
  await pushNewCards().catch(failed);
}
