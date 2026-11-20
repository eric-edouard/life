// The arrival reader (docs/glossary.md): today's new chat and mail lines read as they arrive, one question about action
// only: does it hold an ask, a promise or a wait for him? Apple's on-device model asks first (the trigger, free); its
// yes, a refusal, Thai text or no Apple model goes to his engine (the confirm). Both answers are read replies
// (`storeReply`); what counts is decided only by `confirmedArrivalsOf` (read-replies.ts). Called by the watcher alone,
// on today's units, never on a backfill.

import { clock, DAY } from "../core/clock";
import { newestWithin } from "../core/lists";
import {
  askFoundationModel,
  type FoundationAnswer,
  type FoundationRequest,
} from "../models/foundation-model";
import { isOnline } from "../models/llm";
import { promptText } from "../models/prompt-parts";
import {
  ARRIVAL_CONFIRM_READ,
  ARRIVAL_TRIGGER_READ,
  type ReadReply,
} from "../records/read-reply";
import { eventKey } from "../records/source";
import { firstNameOf, ownerIn } from "../records/truth";
import { type ArrivalReads, arrivalsDue } from "./arrival-gate";
import type { Evidence } from "./gather";
import { READ_REPLIES, readFiles } from "./memory-files";
import { filesDueOnArrival } from "./message-files";
import {
  type Asked,
  makeReplies,
  promptDigestOf,
  READS,
  readRepliesSince,
  storeReply,
} from "./read-replies";
import type { Truth } from "./read-truth";
import { begin, readsOf } from "./run";
import type { Built, Resolve } from "./units";
import { chatLines, messageLine } from "./words";
import { dayNow, localDate, time } from "./zones";

/** The most confirm calls a day (about 24 measured, 20 Nov 2026), failures included. */
export const CONFIRMS_A_DAY = 100;
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
  keys: string[];
  lines: string[];
}

/**
 * Whether Apple's quote is in the lines: at least half of its words of 3 letters or more are words of the text. An
 * empty quote, or one with no such word, is not found.
 */
export function isQuoteFound(quote: string, text: string) {
  const wordsOf = (s: string) =>
    (
      s
        .toLowerCase()
        .normalize("NFKC")
        .match(/[\p{L}\p{N}]+/gu) ?? []
    ).filter((w) => w.length >= 3);
  const words = wordsOf(quote);
  const known = new Set(wordsOf(text));
  return (
    words.length > 0 &&
    words.filter((w) => known.has(w)).length * 2 >= words.length
  );
}

/**
 * The reads due now: each unit the gate lets through, its unread lines (never a message whose file has no line yet),
 * the newest whole lines within `READ_CHARS` (a single line over it cut), oldest first. The older lines left wait for
 * the next tick.
 */
export function arrivalReadsDue(
  evidence: Pick<Evidence, "built" | "fileEvents">,
  read: ArrivalReads,
  resolve: Resolve,
  nameOf: (ref: string) => string,
  now: Date
): ArrivalRead[] {
  return arrivalsDue(evidence, read, now).flatMap((a) => {
    if (!("due" in a)) {
      return [];
    }
    const b = a.unit;
    const fresh = new Set(
      a.fresh.map((m) => eventKey({ id: m.id, source: b.unit.source }))
    );
    const lines = linesOf(b, fresh, resolve, nameOf);
    const shown: typeof lines = [];
    let room = READ_CHARS;
    for (const l of lines.toReversed()) {
      const text = shown.length === 0 ? l.text.slice(0, READ_CHARS) : l.text;
      if (text.length > room) {
        break;
      }
      shown.unshift({ ...l, text });
      room -= text.length + 1;
    }
    return shown.length === 0
      ? []
      : [
          {
            at: b.messages.at(-1)?.at ?? b.unit.end,
            b,
            keys: shown.map((l) => l.key),
            lines: shown.map((l) => l.text),
          },
        ];
  });
}

/** A unit's lines whose keys are in `keys`, as the reads show them: `HH:MM <who>: <text>`, oldest first. */
function linesOf(
  b: Built,
  keys: ReadonlySet<string>,
  resolve: Resolve,
  nameOf: (ref: string) => string
) {
  return chatLines(b, resolve)
    .map((l) => ({
      key: eventKey({ id: l.ref, source: b.unit.source }),
      text: messageLine(time(l.at), nameOf(l.speaker), l.text),
    }))
    .filter((l) => keys.has(l.key));
}

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
    text: lines.join("\n"),
  };
}

/** Apple's answer as stored: its author and quote with the quote check, or why it gave none. */
function triggerReplyOf(answer: FoundationAnswer, text: string) {
  if (!("reply" in answer)) {
    return { refused: answer.error };
  }
  const { author, quote = "" } = answer.reply;
  return {
    author: author === "person" ? "person" : "automated",
    isFound: isQuoteFound(quote, text),
    quote,
  };
}

/** Whether a stored trigger goes on to the confirm: a person's words with a quote found, or no answer. */
const isTriggered = (
  reply: { refused: string } | { author: string; isFound: boolean }
) => "refused" in reply || (reply.author === "person" && reply.isFound);

/** The confirm call of a read, for `makeReplies`. */
const confirmOf = (r: {
  at: string;
  firstAt: string;
  keys: string[];
  lines: string[];
  source: Built["unit"]["source"];
  unit: string;
}): Asked => ({
  at: r.at,
  call: {
    firstAt: r.firstAt,
    input: { lines: r.lines },
    keys: r.keys,
    reads: readsOf([{ source: r.source, unit: r.unit }]),
    starts: [0],
    unit: r.unit,
  },
  read: ARRIVAL_CONFIRM_READ,
});

/** The confirm calls failed today in this process: they count against the day's cap, so a failing read cannot spin. */
const failedToday = { count: 0, day: "" };

/**
 * One pass: Apple reads the due reads (one spawn), its answers are stored, and the confirms due (its yeses and
 * refusals, Thai, no Apple model, and any trigger whose confirm is still pending) are asked of his engine within the
 * day's cap, newest first. Offline, nothing is asked of his engine: the reads stay unread or pending, and are asked
 * when Life is back while the unit is still today's; past midnight the night's ordinary verdict applies.
 */
export async function readArrivals(
  evidence: Pick<Evidence, "built" | "fileEvents">,
  people: { nameOf: (ref: string) => string; resolve: Resolve },
  ownerNames: string[],
  o: {
    apple?: typeof askFoundationModel;
    online?: typeof isOnline;
    step?: () => ReturnType<typeof begin>;
    where?: string;
  } = {}
) {
  const {
    apple = askFoundationModel,
    online = isOnline,
    where = READ_REPLIES,
  } = o;
  const now = clock();
  const day = dayNow();
  // Today's lines may sit in last month's file (filed by their first message's UTC month).
  const stored = readRepliesSince(
    new Date(now.getTime() - DAY).toISOString(),
    where
  ).filter(
    (l) =>
      (l.read === ARRIVAL_TRIGGER_READ || l.read === ARRIVAL_CONFIRM_READ) &&
      localDate(l.at) === day
  );
  const waiting = filesDueOnArrival(
    evidence.fileEvents,
    readFiles(),
    new Set()
  ).due.map(eventKey);
  const read = new Set([...stored.flatMap((l) => l.messages), ...waiting]);
  const due = arrivalReadsDue(
    evidence,
    { ownerNames, read },
    people.resolve,
    people.nameOf,
    now
  );
  if (due.length === 0 && pendingTriggers(stored).length === 0) {
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
    .map((r) => confirmOf(readOf(r)));
  const digest = promptDigestOf(promptText(TRIGGER));
  for (const [i, r] of forApple.entries()) {
    const answer = answers[i] as FoundationAnswer;
    // No Apple model on this Mac (or it failed): nothing stored, his engine reads it.
    if ("error" in answer && answer.error !== "refused") {
      toConfirm.push(confirmOf(readOf(r)));
      continue;
    }
    const reply = triggerReplyOf(answer, r.lines.join("\n"));
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
      readOf(r).firstAt,
      where
    );
    if (isTriggered(reply)) {
      toConfirm.push(confirmOf(readOf(r)));
    }
  }
  toConfirm.push(...pendingConfirms(stored, evidence.built, people));
  if (failedToday.day !== day) {
    Object.assign(failedToday, { count: 0, day });
  }
  const asked =
    stored.filter((l) => l.read === ARRIVAL_CONFIRM_READ).length +
    failedToday.count;
  const taken =
    toConfirm.length > 0 && (await online())
      ? newestWithin(toConfirm, Math.max(0, CONFIRMS_A_DAY - asked), {
          at: (a) => a.at,
          size: () => 1,
        })
      : [];
  const { failed, stored: confirmed } = await makeReplies(taken, step, where);
  failedToday.count += failed.length;
  return step.end({
    apple: forApple.length,
    confirmed,
    confirms: taken.length,
    due: due.length,
    failed: failed.length,
  });
}

/** A read's facts for its stored lines: the instant of its first line, its unit and source. */
function readOf(r: ArrivalRead) {
  const first = r.b.messages.find(
    (m) => eventKey({ id: m.id, source: r.b.unit.source }) === r.keys[0]
  );
  return {
    at: r.at,
    firstAt: first?.at ?? r.b.unit.start,
    keys: r.keys,
    lines: r.lines,
    source: r.b.unit.source,
    unit: r.b.unit.id,
  };
}

const sameKeys = (a: string[], b: string[]) =>
  a.length === b.length && a.every((k, i) => k === b[i]);

/** Today's triggers that go on to a confirm and have none yet (Life was offline, or the cap was spent). */
function pendingTriggers(stored: ReadReply[]) {
  const confirms = stored.filter((l) => l.read === ARRIVAL_CONFIRM_READ);
  return stored.filter(
    (l): l is Extract<ReadReply, { read: typeof ARRIVAL_TRIGGER_READ }> =>
      l.read === ARRIVAL_TRIGGER_READ &&
      isTriggered(l.reply) &&
      !confirms.some((c) => sameKeys(c.messages, l.messages))
  );
}
/** The confirms of pending triggers, their lines read again from today's units (a reply never keeps message text). */
function pendingConfirms(
  stored: ReadReply[],
  built: Built[],
  people: { nameOf: (ref: string) => string; resolve: Resolve }
): Asked[] {
  return pendingTriggers(stored).flatMap((t) => {
    const b = built.find((u) => u.unit.id === t.unit);
    const lines =
      b && linesOf(b, new Set(t.messages), people.resolve, people.nameOf);
    return b && lines && lines.length > 0
      ? [
          confirmOf(
            readOf({
              at: b.messages.at(-1)?.at ?? b.unit.end,
              b,
              keys: lines.map((l) => l.key),
              lines: lines.map((l) => l.text),
            })
          ),
        ]
      : [];
  });
}
