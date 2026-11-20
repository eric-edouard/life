// The arrival reader (docs/glossary.md): today's new chat and mail lines read as they arrive, one question about action
// only: does it hold an ask, a promise or a wait for him? Apple's on-device model asks first (the trigger, free); its
// yes, a refusal, Thai text or no Apple model goes to his engine (the confirm). Both answers are read replies
// (`storeReply`); what counts is decided only by `confirmedArrivalsOf` (read-replies.ts). Called by the watcher alone,
// on today's units, never on a backfill.

import { clock, daysBefore } from "../core/clock";
import { newestWithin, packed } from "../core/lists";
import { log, recentEvents } from "../core/log";
import {
  askFoundationModel,
  type FoundationAnswer,
  type FoundationRequest,
} from "../models/foundation-model";
import { isOnline } from "../models/llm";
import { isPromptVersion, promptText } from "../models/prompt-parts";
import {
  ARRIVAL_CONFIRM_READ,
  ARRIVAL_TRIGGER_READ,
  type ReadReply,
} from "../records/read-reply";
import { eventKey } from "../records/source";
import { firstNameOf, ownerIn } from "../records/truth";
import type { Unit } from "../records/unit";
import { readStore, withStore } from "../sources/lifelog";
import { type ArrivalReads, arrivalsDue } from "./arrival-gate";
import { closedConversations } from "./extract";
import { type Evidence, voiceUnits } from "./gather";
import { keptConversations, READ_REPLIES, readFiles } from "./memory-files";
import { filesDueOnArrival } from "./message-files";
import type { SourceLine } from "./quote-check";
import {
  type Asked,
  makeReplies,
  promptDigestOf,
  READS,
  readRepliesSince,
  storeReply,
} from "./read-replies";
import { OWNER, type Truth } from "./read-truth";
import { begin, readsOf } from "./run";
import { isDirect } from "./sources";
import { applyRules, type Built, type Resolve, UNKNOWN } from "./units";
import { chatLines, messageLine, spokenLines } from "./words";
import { dayNow, dayStart, localDate, time } from "./zones";

/**
 * The most confirm calls a day, failures included: a runaway guard, not a budget (about 27 a day measured, 20 Nov
 * 2026; at most about 7 cents). A read past it is the night's, which reads every unit as it does today.
 */
export const CONFIRMS_A_DAY = 1000;
/** The most characters one read shows: under Apple's 8k-token context. */
const READ_CHARS = 5000;
const THAI = /\p{Script=Thai}/u;
const TRIGGER = READS.arrival_trigger.prompt;

/** His names as a group's line may say them: his name, its first word, what he is called and his aliases. */
export const ownerNamesOf = (truth: Truth) => {
  const owner = ownerIn(truth.people);
  return [
    owner.name,
    firstNameOf(owner.name),
    ...(owner.called ? [owner.called] : []),
    ...owner.aliases,
  ];
};

/** One read due: the unit, the keys of the lines it shows, and those lines. */
export interface ArrivalRead {
  at: string;
  b: Built;
  /** When its first line was written or said: its replies are filed by it. */
  firstAt: string;
  keys: string[];
  lines: string[];
  /** Who wrote the lines shown (refs as read), never him. */
  people: string[];
}

/** A line as the reads show it: its key (`source|id`, a turn's ref for voice), who wrote or said it, its text. */
interface ReadLine {
  at: string;
  key: string;
  speaker: string;
  text: string;
}

/** The reads due now in chats and mail: each unit the gate lets through, all its unread lines (`chunksOf`). */
export function arrivalReadsDue(
  evidence: Pick<Evidence, "built">,
  read: ArrivalReads,
  resolve: Resolve,
  nameOf: (ref: string) => string,
  now: Date
): ArrivalRead[] {
  return arrivalsDue(evidence, read, now).flatMap((a) => {
    if (!("due" in a)) {
      return [];
    }
    const keys = new Set(
      a.fresh.map((m) => eventKey({ id: m.id, source: a.unit.unit.source }))
    );
    return chunksOf(a.unit, linesOf(a.unit, keys, resolve, nameOf), resolve);
  });
}

/**
 * The voice units the reader may read, decided once for fresh reads and pending confirms alike: those of a conversation
 * lifelog has closed (its own signals, never a timing rule of Life's) that he spoke in on any of its days, never one a
 * code rule dropped, and only yesterday's and today's: an earlier day's is the night's. His own words count: what he
 * says he will do is an arrival too.
 */
function readableVoiceOf(
  voice: { built: Built[]; closed: ReadonlySet<string> },
  day: string
) {
  const his = new Set(
    voice.built.filter((b) => b.unit.stats.fromMe > 0).map((b) => b.unit.key)
  );
  return voice.built.filter(
    (b) =>
      b.unit.date >= daysBefore(day, 1) &&
      !b.unit.drop &&
      voice.closed.has(b.unit.key) &&
      his.has(b.unit.key)
  );
}

/** The voice reads due: each readable unit's turns not read yet (`chunksOf`). */
function voiceReadsDue(
  readable: Built[],
  spoken: ReadonlyMap<string, SourceLine[]>,
  read: ReadonlySet<string>,
  resolve: Resolve,
  nameOf: (ref: string) => string
): ArrivalRead[] {
  return readable.flatMap((b) => {
    const lines = (spoken.get(b.unit.id) ?? [])
      .map((l) => readLineOf(b, l, nameOf))
      .filter((l) => !read.has(l.key));
    return chunksOf(b, lines, resolve);
  });
}

/**
 * The one cutter, for fresh reads and a pending confirm's alike: `lines` (oldest first) packed in order into chunks of
 * whole lines within `READ_CHARS` (`packed`; a line over it is a chunk alone), every chunk read in the same pass. A
 * line keeps its one key: Apple is shown a long line cut to fit (`triggerRequest`), the confirm the whole line. Each
 * chunk is dated by its newest line, with the people who wrote or said it (his own lines alone in a one-to-one chat:
 * the other person).
 */
function chunksOf(
  b: Built,
  lines: ReadLine[],
  resolve: Resolve
): ArrivalRead[] {
  // His own lines alone: the other person only in a one-to-one chat (`isDirect`), never a group's earlier speaker.
  const others = b.unit.people
    .filter((p) => p !== OWNER)
    .map((p) =>
      p.startsWith(UNKNOWN) ? (resolve(p.slice(UNKNOWN.length)) ?? p) : p
    );
  const isOneToOne = isDirect(b.unit.source, b.unit.key, others.length);
  return packed(lines, READ_CHARS, (l) => l.text.length + 1).map((shown) => {
    const writers = [
      ...new Set(shown.map((l) => l.speaker).filter((p) => p !== OWNER)),
    ];
    return {
      at: shown.at(-1)?.at ?? b.unit.end,
      b,
      firstAt: shown[0]?.at ?? b.unit.start,
      keys: shown.map((l) => l.key),
      lines: shown.map((l) => l.text),
      people: writers.length === 0 && isOneToOne ? others : writers,
    };
  });
}

/** A source line as the reads show it: `HH:MM <who>: <text>`. */
const readLineOf = (
  b: Built,
  l: SourceLine,
  nameOf: (ref: string) => string
): ReadLine => ({
  at: l.at,
  key: eventKey({ id: l.ref, source: b.unit.source }),
  speaker: l.speaker,
  text: messageLine(time(l.at), nameOf(l.speaker), l.text),
});

/** A chat or mail unit's lines whose keys are in `keys`, oldest first. */
const linesOf = (
  b: Built,
  keys: ReadonlySet<string>,
  resolve: Resolve,
  nameOf: (ref: string) => string
) =>
  chatLines(b, resolve)
    .map((l) => readLineOf(b, l, nameOf))
    .filter((l) => keys.has(l.key));

/** Apple's request for a read: the trigger prompt's instructions, and its two fields' guides. */
function triggerRequest(lines: string[]): FoundationRequest {
  const [instructions = "", ...fields] = promptText(TRIGGER).split("\n## ");
  const guide = (name: string) =>
    (fields.find((f) => f.startsWith(`${name}\n`)) ?? "")
      .slice(name.length)
      .trim();
  return {
    fields: [
      {
        anyOf: ["person", "automated"],
        description: guide("author"),
        name: "author",
      },
      { description: guide("quote"), name: "quote" },
    ],
    instructions: instructions.trim(),
    // A line over `READ_CHARS` is cut for Apple's context alone; the confirm reads it whole.
    text: lines.map((l) => l.slice(0, READ_CHARS)).join("\n"),
  };
}

/** Apple's answer as stored: its author and quote with the quote check, or why it gave none. */
function triggerReplyOf(answer: FoundationAnswer) {
  if (!("reply" in answer)) {
    return { refused: answer.error };
  }
  const { author, quote = "" } = answer.reply;
  return { author: author === "person" ? "person" : "automated", quote };
}

/**
 * Whether a stored trigger goes on to the confirm: anything but automated lines with no ask quoted (measured on 173
 * units, 20 Nov 2026: 72 of 73 asks go on, about 27 confirms a day), or no answer.
 */
const isTriggered = (
  reply: { refused: string } | { author: string; quote: string }
) =>
  "refused" in reply || reply.author === "person" || reply.quote.trim() !== "";

/** The confirm call of a read, for `makeReplies`: it stores the read's unit and who wrote its lines. */
function confirmOf(r: ArrivalRead): Asked {
  return {
    at: r.at,
    call: {
      firstAt: r.firstAt,
      input: { lines: r.lines },
      keys: r.keys,
      people: r.people,
      reads: readsOf([{ source: r.b.unit.source, unit: r.b.unit.id }]),
      starts: [0],
      unit: r.b.unit.id,
    },
    read: ARRIVAL_CONFIRM_READ,
  };
}

/** The confirm calls the model log holds for today, failed ones included: a failing read cannot spin past the cap. */
async function readConfirmsToday() {
  const day = dayNow();
  return (
    await recentEvents<{ at: string; prompt?: string }>(2, "model.run")
  ).filter(
    (e) =>
      e.prompt !== undefined &&
      isPromptVersion(e.prompt, READS.arrival_confirm.prompt) &&
      localDate(e.at) === day
  ).length;
}

/**
 * One pass: Apple reads the due reads (one spawn), its answers are stored, and the confirms due (its yeses and
 * refusals, Thai, no Apple model, and any trigger whose confirm is still pending) are asked of his engine within the
 * day's cap, newest first. Offline, nothing is asked of his engine: the reads stay unread or pending, and are asked
 * when Life is back while the unit is still today's; past midnight the night's ordinary verdict applies.
 */
export async function readArrivals(
  evidence: Pick<Evidence, "built" | "fileEvents"> &
    Partial<Pick<Evidence, "fileLines">> & {
      /** Today's voice units, and the conversations lifelog has closed (`closedConversations`). */
      voice?: { built: Built[]; closed: ReadonlySet<string> };
    },
  people: { nameOf: (ref: string) => string; resolve: Resolve; truth?: Truth },
  ownerNames: string[],
  o: {
    apple?: typeof askFoundationModel;
    /** The confirm calls made today, failures included (default: the model log). */
    confirmsToday?: () => Promise<number>;
    online?: typeof isOnline;
    /** Voice units' lines by unit id (default: `spokenLines`). */
    spoken?: (units: Unit[]) => Promise<ReadonlyMap<string, SourceLine[]>>;
    step?: () => ReturnType<typeof begin>;
    where?: string;
  } = {}
) {
  const {
    apple = askFoundationModel,
    confirmsToday = readConfirmsToday,
    online = isOnline,
    where = READ_REPLIES,
  } = o;
  const now = clock();
  const day = dayNow();
  // Filed by their first line's UTC month: from yesterday's start, the earliest line read (yesterday's voice).
  const stored = readRepliesSince(
    dayStart(daysBefore(day, 1)).toISOString(),
    where
  ).filter(
    (l) =>
      (l.read === ARRIVAL_TRIGGER_READ || l.read === ARRIVAL_CONFIRM_READ) &&
      // Only the current prompts' lines: an older version's answer neither marks a line read nor waits for a confirm.
      isPromptVersion(l.madeBy.prompt, READS[l.read].prompt) &&
      // Yesterday's too: a conversation that ran past midnight is read whole.
      localDate(l.at) >= daysBefore(day, 1)
  );
  const waiting = filesDueOnArrival(
    evidence.fileEvents,
    evidence.fileLines ?? readFiles(),
    new Set()
  ).due.map(eventKey);
  const read = new Set([...stored.flatMap((l) => l.messages), ...waiting]);
  const pending = pendingTriggers(stored, day);
  const pendingUnits = new Set(pending.map((t) => t.unit));
  // Words are fetched only for a unit with a turn not read yet (fewer of its keys read than its turns), or a confirm
  // pending: a conversation read whole fetches nothing again.
  const readOfUnit = Map.groupBy(
    stored.flatMap((l) =>
      "unit" in l ? l.messages.map((k) => ({ k, unit: l.unit })) : []
    ),
    (m) => m.unit
  );
  const fetched = (
    evidence.voice ? readableVoiceOf(evidence.voice, day) : []
  ).filter(
    (b) =>
      pendingUnits.has(b.unit.id) ||
      new Set(readOfUnit.get(b.unit.id)?.map((m) => m.k)).size <
        b.unit.stats.items
  );
  const spoken = await (o.spoken ?? spokenOf(people))(
    fetched.map((b) => b.unit)
  ).catch((e: Error) => {
    // lifelog unreadable: chats and mail are still read, voice on a later pass.
    log("run.error", { error: e.message, step: "arrivals.voice" });
    return new Map<string, SourceLine[]>();
  });
  // A speaker corrected between the store's two reads (his turns there, none in the words): not his, not read.
  const notHis = new Set(
    fetched
      .filter(
        (b) =>
          b.unit.stats.fromMe > 0 &&
          !(spoken.get(b.unit.id) ?? []).some((l) => l.speaker === OWNER)
      )
      .map((b) => b.unit.key)
  );
  const voice = fetched.filter((b) => !notHis.has(b.unit.key));
  const lineSources = { built: [...evidence.built, ...voice], spoken };
  const due = [
    ...arrivalReadsDue(
      evidence,
      { ownerNames, read },
      people.resolve,
      people.nameOf,
      now
    ),
    ...voiceReadsDue(voice, spoken, read, people.resolve, people.nameOf),
  ];
  if (due.length === 0 && pending.length === 0) {
    return;
  }
  const step = await (
    o.step ??
    (() =>
      begin("arrival-reader", "main", {
        prompts: [TRIGGER, READS.arrival_confirm.prompt],
      }))
  )();
  const forApple = due.filter((r) => !THAI.test(r.lines.join("\n")));
  const answers = await apple(forApple.map((r) => triggerRequest(r.lines)));
  const toConfirm: Asked[] = due
    .filter((r) => !forApple.includes(r))
    .map(confirmOf);
  const digest = promptDigestOf(promptText(TRIGGER));
  for (const [i, r] of forApple.entries()) {
    const answer = answers[i] as FoundationAnswer;
    // No Apple model on this Mac (or it failed): nothing stored, his engine reads it.
    if ("error" in answer && answer.error !== "refused") {
      toConfirm.push(confirmOf(r));
      continue;
    }
    const reply = triggerReplyOf(answer);
    storeReply(
      {
        at: clock().toISOString(),
        madeBy: {
          model: "apple-on-device",
          os: "os" in answer ? answer.os : "",
          prompt: TRIGGER,
          run: step.run,
        },
        messages: r.keys,
        promptDigest: digest,
        read: ARRIVAL_TRIGGER_READ,
        reply,
        schemaVersion: 1,
        starts: [0],
        unit: r.b.unit.id,
      } as ReadReply,
      confirmOf(r).call.firstAt,
      where
    );
    if (isTriggered(reply)) {
      toConfirm.push(confirmOf(r));
    }
  }
  toConfirm.push(...pendingConfirms(pending, lineSources, people));
  const room =
    toConfirm.length > 0 && (await online())
      ? CONFIRMS_A_DAY - (await confirmsToday())
      : 0;
  const taken =
    room > 0
      ? newestWithin(toConfirm, room, {
          at: (a) => a.at,
          size: () => 1,
        })
      : [];
  const { failed, stored: confirmed } = await makeReplies(taken, step, where);
  return step.end({
    apple: forApple.length,
    confirmed,
    confirms: taken.length,
    due: due.length,
    failed: failed.length,
  });
}

const sameKeys = (a: string[], b: string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * Today's triggers that go on to a confirm and have none yet (Life was offline, or the cap was spent). An earlier day's
 * is the night's, never confirmed when the next day's allowance opens.
 */
function pendingTriggers(stored: ReadReply[], day: string) {
  const confirms = stored.filter((l) => l.read === ARRIVAL_CONFIRM_READ);
  return stored.filter(
    (l): l is Extract<ReadReply, { read: typeof ARRIVAL_TRIGGER_READ }> =>
      l.read === ARRIVAL_TRIGGER_READ &&
      localDate(l.at) === day &&
      isTriggered(l.reply) &&
      !confirms.some((c) => sameKeys(c.messages, l.messages))
  );
}
/**
 * The confirms of pending triggers, their lines read again from today's units by the same cutter (a reply never keeps
 * message text). Only when it gives back exactly the trigger's lines: otherwise the night reads the unit.
 */
function pendingConfirms(
  pending: ReturnType<typeof pendingTriggers>,
  units: { built: Built[]; spoken: ReadonlyMap<string, SourceLine[]> },
  people: { nameOf: (ref: string) => string; resolve: Resolve }
): Asked[] {
  return pending.flatMap((t) => {
    const b = units.built.find((u) => u.unit.id === t.unit);
    if (!b) {
      return [];
    }
    const keys = new Set(t.messages);
    const lines = units.spoken.has(b.unit.id)
      ? (units.spoken.get(b.unit.id) ?? [])
          .map((l) => readLineOf(b, l, people.nameOf))
          .filter((l) => keys.has(l.key))
      : linesOf(b, keys, people.resolve, people.nameOf);
    const [r, ...more] = chunksOf(b, lines, people.resolve);
    return r && more.length === 0 && sameKeys(r.keys, t.messages)
      ? [confirmOf(r)]
      : [];
  });
}

/** Today's voice units' lines, by unit id, from the watcher's store and lifelog (`spokenLines`). */
const spokenOf =
  (people: { resolve: Resolve; truth?: Truth }) => (units: Unit[]) =>
    units.length === 0 || !people.truth
      ? Promise.resolve(new Map<string, SourceLine[]>())
      : spokenLines(units, people.resolve, people.truth, readStore);

/**
 * The voice units of yesterday and today as the gather builds them (the code rules applied, chapter units left out),
 * read-only from the watcher's store, and the conversations lifelog has closed: what the reader reads of voice.
 * Yesterday's too, so a conversation that ran past midnight is read whole.
 */
export const readRecentVoice = (day: string, truth: Truth) =>
  withStore(async (store) => {
    const v = await voiceUnits(store, dayStart(daysBefore(day, 1)), truth);
    return {
      built: applyRules(v.built, keptConversations()),
      closed: closedConversations(v.conversations),
    };
  }, readStore);
