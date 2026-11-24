// The arrival reader (docs/glossary.md): today's new chat and mail lines read as they arrive, one question: as the
// conversation stands now, what is still left for him, and how much does it matter? His engine asks it (the confirm),
// shown the conversation's sitting up to the new lines and the time now. Apple's on-device model only sieves mail (the
// trigger, free): an automated mail goes no further; Apple failing leaves the read for the next pass. Both answers are
// read replies
// (`storeReply`); what counts is decided only by `confirmedArrivalsOf` (read-replies.ts). Called by the watcher alone,
// on today's units, never on a backfill.

import { clock, daysBefore } from "../core/clock";
import { newestWithin, packed } from "../core/lists";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import {
  askFoundationModel,
  type FoundationAnswer,
  type FoundationRequest,
} from "../models/foundation-model";
import { isOnline } from "../models/llm";
import { isPromptVersion, promptText } from "../models/prompt-parts";
import {
  ARRIVAL_APPOINTMENT_READ,
  ARRIVAL_CONFIRM_READ,
  ARRIVAL_TRIGGER_READ,
  LeftReply,
  type ReadReply,
} from "../records/read-reply";
import { eventKey } from "../records/source";
import { firstNameOf, ownerIn } from "../records/truth";
import { type LifelogTurn, readStore, withStore } from "../sources/lifelog";
import { checkedAppointmentReply } from "./arrival-appointments";
import { type ArrivalReads, arrivalsDue } from "./arrival-gate";
import { EXCHANGE_ENDS_AFTER, exchangesOf, isFinished } from "./exchanges";
import { closedConversations } from "./extract";
import { type Evidence, voiceUnits } from "./gather";
import { keptConversations, READ_REPLIES } from "./memory-files";
import { filesDueOnArrival, readFiles } from "./message-files";
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
import { readCallsToday } from "./run-log";
import { isDirect, kindOf } from "./sources";
import { voiceUnitId } from "./unit-ids";
import {
  applyRules,
  type Built,
  conversationKeyOf,
  type Resolve,
  turnsByDayOf,
  UNKNOWN,
} from "./units";
import { chatLines, messageLine, turnLines } from "./words";
import { dayNow, dayStart, localDate, time, zoneNow } from "./zones";

/**
 * The most confirm calls a day, failures included: a runaway guard, not a budget (114 on its first day, 20 Nov 2026,
 * for $0.02; at most about 7 cents). A read past it is the night's, which reads every unit as it does today.
 */
export const CONFIRMS_A_DAY = 1000;
/** The most characters one read shows: under Apple's 8k-token context. */
const READ_CHARS = 5000;
const THAI = /\p{Script=Thai}/u;
/** How much of each new mail Apple's sieve is shown: its start. */
const SIEVE_CHARS = 600;
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
  /** What the confirm is shown: the sitting its newest line is in (`exchangesOf`), up to it, its last `READ_CHARS`. */
  context: string[];
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
    const all = linesOf(a.unit, undefined, resolve, nameOf);
    return chunksOf(
      a.unit,
      all.filter((l) => keys.has(l.key)),
      resolve,
      all
    );
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
    const all = (spoken.get(b.unit.id) ?? []).map((l) =>
      readLineOf(b, l, nameOf)
    );
    return chunksOf(
      b,
      all.filter((l) => !read.has(l.key)),
      resolve,
      all
    );
  });
}

/**
 * The one cutter, for fresh reads and a pending confirm's alike: `lines` (oldest first) packed in order into chunks of
 * whole lines within `READ_CHARS` (`packed`; a line over it is a chunk alone), every chunk read in the same pass. A
 * line keeps its one key: Apple is shown a mail's start (`triggerRequest`), the confirm the whole line. Each
 * chunk is dated by its newest line, with the people who wrote or said it (his own lines alone in a one-to-one chat:
 * the other person).
 */
function chunksOf(
  b: Built,
  lines: ReadLine[],
  resolve: Resolve,
  /** Every line of the unit, oldest first: each chunk's sitting is cut from them. */
  all: ReadLine[]
): ArrivalRead[] {
  // His own lines alone: the other person only in a one-to-one chat (`isDirect`), never a group's earlier speaker.
  const others = b.unit.people
    .filter((p) => p !== OWNER)
    .map((p) =>
      p.startsWith(UNKNOWN) ? (resolve(p.slice(UNKNOWN.length)) ?? p) : p
    );
  const isOneToOne = isDirect(b.unit.source, b.unit.key, others.length);
  // Cut by sitting first: a chunk never spans two, so its sitting shows every line it stores as read.
  const size = (l: ReadLine) => l.text.length + 1;
  const chunks = exchangesOf(lines).flatMap((x) => packed(x, READ_CHARS, size));
  return chunks.map((shown) => {
    const writers = [
      ...new Set(shown.map((l) => l.speaker).filter((p) => p !== OWNER)),
    ];
    return {
      at: shown.at(-1)?.at ?? b.unit.end,
      b,
      context: sittingOf(all, shown),
      firstAt: shown[0]?.at ?? b.unit.start,
      keys: shown.map((l) => l.key),
      lines: shown.map((l) => l.text),
      people: writers.length === 0 && isOneToOne ? others : writers,
    };
  });
}

/**
 * What the confirm is shown for `shown` (one sitting's lines, oldest first): every line of the unit from its first to
 * its last, then the sitting's earlier lines (an exchange, `EXCHANGE_ENDS_AFTER`) while they fit `READ_CHARS`: the
 * conversation as it stood when its newest line came, other people's answered lines and his own included.
 */
function sittingOf(all: ReadLine[], shown: ReadLine[]) {
  const first = all.findIndex((l) => l.key === shown[0]?.key);
  const last = all.findIndex((l) => l.key === shown.at(-1)?.key);
  const sitting = exchangesOf(all.slice(0, last + 1)).at(-1) ?? [];
  const span = all.slice(first, last + 1);
  let room = READ_CHARS - span.reduce((n, l) => n + l.text.length + 1, 0);
  const before = sitting
    .slice(0, sitting.length - span.length)
    .toReversed()
    .filter((l) => {
      room -= l.text.length + 1;
      return room >= 0;
    })
    .toReversed();
  return [...before, ...span].map((l) => l.text);
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

/** A chat or mail unit's lines (those whose keys are in `keys`, when given), oldest first. */
const linesOf = (
  b: Built,
  keys: ReadonlySet<string> | undefined,
  resolve: Resolve,
  nameOf: (ref: string) => string
) =>
  chatLines(b, resolve)
    .map((l) => readLineOf(b, l, nameOf))
    .filter((l) => !keys || keys.has(l.key));

/** Apple's request for a mail's read: each new mail's sender and start, the trigger prompt's instructions, and its three fields' guides. */
function triggerRequest(r: ArrivalRead): FoundationRequest {
  const keys = new Set(r.keys);
  const mails = r.b.messages.filter((m) =>
    keys.has(eventKey({ id: m.id, source: r.b.unit.source }))
  );
  const [instructions = "", ...fields] = promptText(TRIGGER).split("\n## ");
  const guide = (name: string) =>
    (fields.find((f) => f.startsWith(`${name}\n`)) ?? "")
      .slice(name.length)
      .trim();
  return {
    fields: [
      {
        anyOf: ["person", "automated"],
        description: guide("writer"),
        name: "writer",
      },
      { anyOf: ["yes", "no"], description: guide("needs"), name: "needs" },
      { anyOf: ["yes", "no"], description: guide("event"), name: "event" },
    ],
    instructions: instructions.trim(),
    // Its start only: who sent it and how it opens is what tells a person from a system (a week's replay, 15 to 21 Nov 2026: 92 of 223 mail reads sieved out).
    text: mails
      .map((m) => `From: ${m.sender}\n${m.text.slice(0, SIEVE_CHARS)}`)
      .join("\n\n"),
  };
}

/** Apple's answer as stored: who wrote the mail, whether it needs him, whether it sets a meeting, or why it gave none. */
function triggerReplyOf(answer: FoundationAnswer) {
  if (!("reply" in answer)) {
    return { refused: answer.error };
  }
  const { event, needs, writer } = answer.reply;
  return {
    author: writer === "person" ? "person" : "automated",
    event: event === "yes" ? "yes" : "no",
    needs: needs === "yes" ? "yes" : "no",
  };
}

/** His engine's two reads of a read: each by its name, and how it is asked. */
const CONFIRM = {
  ask: (r: ArrivalRead) => confirmOf(r),
  read: ARRIVAL_CONFIRM_READ,
} as const;
const APPOINTMENT = {
  ask: (r: ArrivalRead) => appointmentOf(r),
  read: ARRIVAL_APPOINTMENT_READ,
} as const;

/**
 * The one routing rule: the reads of his engine a read goes on to. With no answer yet (a conversation, Thai mail, no
 * Apple model), the confirm. After Apple's sieve of a mail: the confirm unless Apple called it automated and needing nothing, the
 * appointment read when it sets a meeting (a booking mail is automated and still read), both on a refusal. After a
 * confirm asked straight: the appointment read when it sets a meeting.
 */
const readsAfterOf = (reply?: object) => {
  if (!reply) {
    return [CONFIRM];
  }
  if ("refused" in reply) {
    return [CONFIRM, APPOINTMENT];
  }
  return [
    ...("author" in reply &&
    !(reply.author === "automated" && "needs" in reply && reply.needs === "no")
      ? [CONFIRM]
      : []),
    ...("event" in reply && reply.event === "yes" ? [APPOINTMENT] : []),
  ];
};

/**
 * Apple sieves mail he received only (his decision of 21 Nov 2026): a conversation, Thai it cannot read, and mail
 * holding his own lines (where his promises are) go straight to his engine.
 */
const isSieved = (r: ArrivalRead) =>
  kindOf(r.b.unit.source) === "mail" &&
  !THAI.test(r.lines.join("\n")) &&
  !r.b.messages.some(
    (m) =>
      m.fromMe &&
      r.keys.includes(eventKey({ id: m.id, source: r.b.unit.source }))
  );

/** The appointment read of a read, for `makeReplies`: its reply stored after `checkedAppointmentReply`. */
function appointmentOf(r: ArrivalRead): Asked {
  const firstDay = localDate(r.firstAt);
  return {
    at: r.at,
    call: {
      checked: (answer) =>
        checkedAppointmentReply(answer, { firstDay, lines: r.lines }),
      firstAt: r.firstAt,
      input: {
        firstDay,
        here: zoneNow() ?? null,
        lastDay: localDate(r.at),
        lines: r.lines,
      },
      keys: r.keys,
      reads: readsOf([{ source: r.b.unit.source, unit: r.b.unit.id }]),
      starts: [0],
      unit: r.b.unit.id,
    },
    read: ARRIVAL_APPOINTMENT_READ,
  };
}

/** The confirm call of a read, for `makeReplies`: its sitting and the time now; it stores the read's unit and who wrote its lines. */
function confirmOf(r: ArrivalRead): Asked {
  return {
    at: r.at,
    call: {
      firstAt: r.firstAt,
      input: { lines: r.context, now: time(clock().toISOString()) },
      keys: r.keys,
      people: r.people,
      reads: readsOf([{ source: r.b.unit.source, unit: r.b.unit.id }]),
      starts: [0],
      unit: r.b.unit.id,
    },
    read: ARRIVAL_CONFIRM_READ,
  };
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
      /** Today's voice from one read of the watcher's store (`readRecentVoice`). */
      voice?: RecentVoice;
    },
  people: { nameOf: (ref: string) => string; resolve: Resolve },
  ownerNames: string[],
  o: {
    apple?: typeof askFoundationModel;
    /** The confirm calls made today, failures included (default: the model log). */
    confirmsToday?: () => Promise<number>;
    online?: typeof isOnline;
    /** The words of voice units' turns, by unit id (default: `turnLines`). */
    spoken?: (
      turns: Map<string, LifelogTurn[]>
    ) => Promise<ReadonlyMap<string, SourceLine[]>>;
    step?: () => ReturnType<typeof begin>;
    where?: string;
  } = {}
) {
  const {
    apple = askFoundationModel,
    confirmsToday = () =>
      readCallsToday([
        READS.arrival_confirm.prompt,
        READS.arrival_appointment.prompt,
      ]),
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
      (l.read === ARRIVAL_TRIGGER_READ ||
        l.read === ARRIVAL_CONFIRM_READ ||
        l.read === ARRIVAL_APPOINTMENT_READ) &&
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
  const pending = [
    ...pendingReadsOf(stored, day),
    ...endedReadsOf(stored, evidence.built, day, now),
  ];
  const pendingUnits = new Set(pending.map(({ t }) => t.unit));
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
  // Only the snapshot's turns are read: a conversation reopened since is read as it was when closed.
  const spoken = await (
    o.spoken ??
    ((turns) =>
      turnLines(
        turns,
        [...new Set(fetched.map((b) => b.unit.key))],
        people.resolve,
        undefined,
        new Map(fetched.map((b) => [b.unit.id, conversationKeyOf(b.unit)]))
      ))
  )(
    new Map(
      fetched.map((b) => [
        b.unit.id,
        evidence.voice?.turns.get(b.unit.id) ?? [],
      ])
    )
  ).catch((e: Error) => {
    // lifelog unreadable: chats and mail are still read, voice on a later pass.
    log("run.error", { ...errorOf(e), step: "arrivals.voice" });
    return new Map<string, SourceLine[]>();
  });
  const lineSources = { built: [...evidence.built, ...fetched], spoken };
  const due = [
    ...arrivalReadsDue(
      evidence,
      { ownerNames, read },
      people.resolve,
      people.nameOf,
      now
    ),
    ...voiceReadsDue(fetched, spoken, read, people.resolve, people.nameOf),
  ];
  if (due.length === 0 && pending.length === 0) {
    return 0;
  }
  const step = await (
    o.step ??
    (() =>
      begin("arrival-reader", "main", {
        prompts: [
          TRIGGER,
          READS.arrival_confirm.prompt,
          READS.arrival_appointment.prompt,
        ],
      }))
  )();
  const forApple = due.filter(isSieved);
  const requests = forApple.map(triggerRequest);
  const appleStart = performance.now();
  const answers = await apple(requests);
  // Apple's own time, apart from the confirms: guided generation slows down on macOS 27 (Apple's open bug).
  const appleMs = Math.round(performance.now() - appleStart);
  // A conversation, and Thai mail, go straight to his engine's confirm.
  const toConfirm: Asked[] = due
    .filter((r) => !forApple.includes(r))
    .flatMap((r) => readsAfterOf().map((x) => x.ask(r)));
  const digest = promptDigestOf(promptText(TRIGGER));
  for (const [i, r] of forApple.entries()) {
    const answer = answers[i] as FoundationAnswer;
    // Apple failed (an outage, ModelManagerError 1013 among them): nothing stored, read again on the next pass.
    if ("error" in answer && answer.error === "failed") {
      continue;
    }
    // No Apple model on this Mac: nothing stored, his engine reads it.
    if ("error" in answer && answer.error !== "refused") {
      toConfirm.push(...readsAfterOf().map((x) => x.ask(r)));
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
    toConfirm.push(...readsAfterOf(reply).map((x) => x.ask(r)));
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
  await step.end({
    apple: forApple.length,
    appleMs,
    confirmed,
    confirms: taken.length,
    due: due.length,
    failed: failed.length,
  });
  // How many appointment reads were stored: the watcher then brings his calendar in line at once.
  return taken.filter(
    (a) => a.read === ARRIVAL_APPOINTMENT_READ && !failed.includes(a)
  ).length;
}

const sameKeys = (a: string[], b: string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/**
 * The one rule of which of his engine's reads a read still waits for (Life was offline, the cap was spent, a call
 * failed, a confirm asked straight that sets a meeting), each on the keys it was first read on, so new lines never join
 * it: the reads its answer sends on (`readsAfterOf`). Only today's: an earlier day's is the night's, never read when
 * the next day's allowance opens.
 */
function pendingReadsOf(stored: ReadReply[], day: string) {
  const isMade = (read: string, keys: string[]) =>
    stored.some((c) => c.read === read && sameKeys(c.messages, keys));
  return stored.flatMap((t) => {
    if (
      !("unit" in t) ||
      localDate(t.at) !== day ||
      t.read === ARRIVAL_APPOINTMENT_READ ||
      // A trigger's confirm sends nothing on: Apple already said whether the mail sets a meeting.
      (t.read === ARRIVAL_CONFIRM_READ &&
        isMade(ARRIVAL_TRIGGER_READ, t.messages))
    ) {
      return [];
    }
    return readsAfterOf(t.reply)
      .filter((x) => !isMade(x.read, t.messages))
      .map((x) => ({ ask: x.ask, t }));
  });
}

/**
 * The confirms read again once their conversation ended by itself (`isFinished`, `EXCHANGE_ENDS_AFTER`): a unit's newest
 * confirm that saw him in the middle of something (`inProgress`) and was made before its sitting ended. Its new line,
 * on the same keys, then decides (`confirmedArrivalsOf`); being after the end, it is never read again.
 */
function endedReadsOf(
  stored: ReadReply[],
  built: Built[],
  day: string,
  now: Date
) {
  const newest = new Map(
    stored
      .flatMap((l) =>
        l.read === ARRIVAL_CONFIRM_READ && localDate(l.at) === day ? [l] : []
      )
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .map((l) => [l.unit, l])
  );
  return [...newest.values()].flatMap((t) => {
    const b = built.find((u) => u.unit.id === t.unit);
    const last = t.messages.at(-1);
    const at = b?.messages.find(
      (m) => eventKey({ id: m.id, source: b.unit.source }) === last
    )?.at;
    if (!(b && at && LeftReply.safeParse(t.reply).data?.inProgress.length)) {
      return [];
    }
    const sitting = exchangesOf(b.messages).find((x) =>
      x.some((m) => m.at === at)
    );
    const endsAt =
      sitting && Date.parse(sitting.at(-1)?.at ?? "") + EXCHANGE_ENDS_AFTER;
    return sitting &&
      endsAt &&
      isFinished(sitting, now) &&
      Date.parse(t.at) < endsAt
      ? [{ ask: CONFIRM.ask, t }]
      : [];
  });
}

/**
 * The confirms of pending triggers, their lines read again from today's units by the same cutter (a reply never keeps
 * message text). Only when it gives back exactly the trigger's lines: otherwise the night reads the unit.
 */
function pendingConfirms(
  pending: ReturnType<typeof pendingReadsOf>,
  units: { built: Built[]; spoken: ReadonlyMap<string, SourceLine[]> },
  people: { nameOf: (ref: string) => string; resolve: Resolve }
): Asked[] {
  return pending.flatMap(({ ask, t }) => {
    const b = units.built.find((u) => u.unit.id === t.unit);
    if (!b) {
      return [];
    }
    const keys = new Set(t.messages);
    const all = units.spoken.has(b.unit.id)
      ? (units.spoken.get(b.unit.id) ?? []).map((l) =>
          readLineOf(b, l, people.nameOf)
        )
      : linesOf(b, undefined, people.resolve, people.nameOf);
    const [r, ...more] = chunksOf(
      b,
      all.filter((l) => keys.has(l.key)),
      people.resolve,
      all
    );
    return r && more.length === 0 && sameKeys(r.keys, t.messages)
      ? [ask(r)]
      : [];
  });
}

/** What the reader reads of voice, from one read of the watcher's store (`readRecentVoice`). */
export interface RecentVoice {
  built: Built[];
  /** The conversations lifelog has closed (`closedConversations`). */
  closed: ReadonlySet<string>;
  /** Each unit's turns, by unit id: who spoke and when, as the same read saw them. */
  turns: ReadonlyMap<string, LifelogTurn[]>;
}

/**
 * The voice units of yesterday and today as the gather builds them (the code rules applied, chapter units left out),
 * the conversations lifelog has closed and each unit's turns, all from one read-only read of the watcher's store, so
 * closure, speakers and turns agree. Yesterday's too, so a conversation that ran past midnight is read whole.
 */
export const readRecentVoice = (
  day: string,
  truth: Truth
): Promise<RecentVoice> =>
  withStore(async (store) => {
    const v = await voiceUnits(store, dayStart(daysBefore(day, 1)), truth);
    return {
      built: applyRules(v.built, keptConversations()),
      closed: closedConversations(v.conversations),
      turns: new Map(
        v.conversations.flatMap((c) =>
          [...turnsByDayOf(c)].map(([date, turns]) => [
            voiceUnitId(c.id, date),
            turns,
          ])
        )
      ),
    };
  }, readStore);
