import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { clock, daysBefore, HOUR } from "../core/clock";
import { readJson, readLineCount, writeJson } from "../core/files";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import type { Push, PushLevel } from "../core/push";
import type { InboxCheck } from "../memory/checks";
import { deliveryOf } from "../memory/decision-delivery";
import { DECISIONS } from "../memory/decision-lines";
import { decisionsNow } from "../memory/decisions";
import { draftsOf, type StoredDraft } from "../memory/draft";
import { instructionsFor } from "../memory/instructions";
import { isLocked } from "../memory/memory-lock";
import { cardSubjectOf } from "../memory/who";
import { dayNow } from "../memory/zones";
import { WATCH } from "../sources/voice-server";
import { notifyPhone, pushIdOf } from "../sources/voice-server-push";
import { inboxChecksNow } from "./inbox";

// A push for each agent's card the gate delivers, once, the only push of cards (the v4 plan, bundle E; Life's own checks
// wait in the list and push nothing, his yes of 25 Nov 2026, question 18): its kind (`card.new`), its level
// (`pushLevelOf`) and its `pushId` (an HMAC of its ref under a key that never leaves the Mac). Never a word, a title, a
// question, a name, a count or a ref: it goes through Apple (SECURITY.md). The
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
  /** The `pushId`s open at the last whole look (`whole`): one gone since is removed from his phone. */
  open?: string[];
  /** Each card's `pushId` and its subject's (`subjectIdOf`), and the last day it was seen open. */
  seen: Record<string, string>;
}

type Open = Pick<InboxCheck, "deadline" | "group" | "pushId" | "ref"> & {
  draft?: StoredDraft | null;
  drafts?: StoredDraft[];
  matter?: { id: string } | null;
};

/** The one push a card has: its kind and its id, never a word of it. */
type CardPush = Extract<Push, { kind: "card.new" }>;

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
 * state) pushes nothing. A `whole` look holds every open card, and what was open at the last one and is not now is
 * removed from his phone; without it `open` holds only some kinds, and nothing is removed.
 */
async function pushNew(open: Open[], whole: boolean, now = clock()) {
  const { silent } = gateStatesOf(now);
  const today = dayNow(now);
  const before = readJson<Seen>(SEEN);
  if (!(before || whole)) {
    return;
  }
  const cutoff = daysBefore(today, FORGET_DAYS);
  const seen = Object.fromEntries([
    ...Object.entries(before?.seen ?? {}).filter(([, day]) => day > cutoff),
    ...open.flatMap((c) => [
      [c.pushId, today],
      [subjectIdOf(c), today],
    ]),
  ]);
  const looked = whole ? open.map((c) => c.pushId) : before?.open;
  const next: Seen = { ...(looked ? { open: looked } : {}), seen };
  // Written before the push, so one that fails is not repeated every look: the inbox still tells him.
  if (!isDeepStrictEqual(before, next)) {
    writeJson(SEEN, next);
  }
  if (!before) {
    return;
  }
  const removed = whole
    ? (before.open ?? []).filter((id) => !looked?.includes(id))
    : [];
  // ponytail: past REMOVED_MAX at once, the phone's next whole read of the inbox removes the rest.
  if (removed.length > 0) {
    await notifyPhone({
      kind: "cards.removed",
      removed: removed.slice(0, REMOVED_MAX),
    });
  }
  const pushes: CardPush[] = open.flatMap((c) =>
    c.group !== "decision" || isSeen(c, before.seen) || silent.has(c.ref)
      ? []
      : [
          {
            kind: "card.new" as const,
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
  await pushInOrder(pushes);
}

/**
 * One at a time, in his inbox's order: the phone shows them as they come. Each one the voice server took is a
 * `card.push_accepted` line (the voice server may still skip Apple), by its push id.
 */
async function pushInOrder(pushes: CardPush[]) {
  for (const p of pushes) {
    // biome-ignore lint/performance/noAwaitInLoops: in his inbox's order
    if (await notifyPhone(p)) {
      log("card.push_accepted", { loudness: p.level, pushId: p.pushId });
    }
  }
}

/** Pushes what is new in his inbox. */
export async function pushNewCards(now = clock()) {
  // A card the gate has not read yet is neither seen nor pushed: it pushes once delivered.
  const { pending } = gateStatesOf(now);
  const open = (await inboxChecksNow()).filter((c) => !pending.has(c.ref));
  await pushNew(open, true, now);
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
      })),
    false
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
