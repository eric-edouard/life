import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { clock, DAY, iso } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { digest } from "../core/hash";
import type { CallReads } from "../models/model-call";
import { isPromptVersion, MAY_KEEP, promptText } from "../models/prompt-parts";
import {
  ARRIVAL_CONFIRM_READ,
  type ReadName,
  ReadReply,
} from "../records/read-reply";
import { READ_REPLIES, readReplyPath } from "./memory-files";
import { inBatches, type Step } from "./run";

// The store of a model's reads (docs/glossary.md, "read reply"): each reply kept as given (a voice naming's after `checkedVoices`) in
// memory/read-replies/ (model output is expensive), what is pending derived from the stored lines (`replyOf`). The
// one writer and reader of that folder (or of a trial's).

/** The prompt of each read; the moves reads' shape is `MOVES`, `memory/moves.ts`, the summary's is `memory/conversation-summaries.ts`, the voice naming's `memory/voice-naming.ts`. */
export const READS = {
  arrival_appointment: { prompt: "memory-arrival-appointment.v1" },
  arrival_confirm: { prompt: "memory-arrival-confirm.v2" },
  arrival_trigger: { prompt: "memory-arrival-trigger.v3" },
  conflict: { prompt: "memory-conflict.v2" },
  connection: { prompt: "memory-connection.v3" },
  conversation_summary: { prompt: "memory-conversation-summary.v1" },
  mentions: { prompt: "memory-mentions.v1" },
  voice_naming: { prompt: "memory-voice-naming.v1" },
} satisfies Record<ReadName, { prompt: string }>;
/** The digest of a prompt's text, stored beside its name and never matched on. */
export const promptDigestOf = (text: string) => digest("sha256", text, 16);

/** One call: what the model is shown (`input`), the key of each message its lines are, the instant of the first, and where each item starts in them. */
interface Call {
  /** What a reply must pass before it is stored (the voice naming's `checkedVoices`); it may throw, so nothing is stored. */
  checked?: (reply: unknown) => unknown;
  firstAt: string;
  input: object;
  keys: string[];
  /** Who wrote its lines, for the read that stores it (the arrival confirm). */
  people?: string[];
  /** What the call is shown, counted per source (`readsOf`). */
  reads: CallReads;
  starts: number[];
  /** The unit its lines are of, for the reads that store it (the arrival reader's). */
  unit?: string;
}

/** A call to make, with the instant of its newest exchange (the night asks the newest first). */
export interface Asked {
  at: string;
  call: Call;
  read: ReadName;
}

/** The month files of a folder of replies (memory's, or a trial's), oldest month first. */
const filesOf = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.endsWith(".jsonl"))
        .sort()
        .map((n) => join(dir, n))
    : [];

/** A file's stored lines, by `readAppended` (its new lines only). */
const readReplyFile = (file: string) =>
  readAppended(
    file,
    ReadReply,
    (last?: ReadReply[]) => [...(last ?? [])],
    (all, line) => {
      all.push(line);
    }
  );

/** The stored lines of each file of the folder `where`, oldest first. */
export const readReplies = (where = READ_REPLIES) =>
  filesOf(where).map(readReplyFile);

/**
 * The stored lines of the month files an instant window touches (replies are filed by their first message's UTC
 * month): a reader of recent replies never reads every year.
 */
export const readRepliesSince = (since: string, where = READ_REPLIES) =>
  filesOf(where)
    .filter((f) => f >= readReplyPath(since, where))
    .flatMap(readReplyFile);

/** The stored lines of the month files of `months` (`YYYY-MM`), one list each as `readReplies` gives it (none: empty). */
export const readRepliesOfMonths = (
  months: readonly string[],
  where = READ_REPLIES
) => [...new Set(months)].map((m) => readReplyFile(readReplyPath(m, where)));

/** A confirmed arrival: new lines of a unit his engine confirmed hold an ask, a promise or a wait for him. */
export interface ConfirmedArrival {
  at: string;
  /** The keys of the messages the confirm read, oldest first. */
  messages: string[];
  /** Who wrote them, as read (never him). */
  people: string[];
  unit: string;
}

/**
 * The one rule of what is a confirmed arrival: a confirm line, of any prompt version, that says `isActionable`, the
 * newest (by `at`) of those ending at the same message (the desk's wake id), so a message wakes one agent. An older
 * prompt's yes still counts: the reader reads only today's lines, so a prompt bumped before the night would otherwise
 * leave that day's confirmed units unread (an importance-1 reply keeping a promise). Read by extraction's choice of
 * units and the desk's wake, never decided twice.
 */
export const confirmedArrivalsOf = (lines: ReadReply[]): ConfirmedArrival[] => [
  ...new Map(
    lines
      .flatMap((l) =>
        l.read === ARRIVAL_CONFIRM_READ && l.reply.isActionable === true
          ? [{ at: l.at, messages: l.messages, people: l.people, unit: l.unit }]
          : []
      )
      .toSorted((a, b) => a.at.localeCompare(b.at))
      .map((a) => [a.messages.at(-1), a])
  ).values(),
];

/**
 * The confirmed arrivals stored since the instant `since`. A confirm is filed by its first line's month, at most two
 * days before it was made (the reader reads yesterday's voice too), so the files from two days before `since` are read.
 */
export const readConfirmedArrivals = (since: string, where = READ_REPLIES) =>
  confirmedArrivalsOf(
    readRepliesSince(iso(Date.parse(since) - 2 * DAY), where)
  ).filter((a) => a.at >= since);

/** A stored exchange: its place in the line that read it, and the keys of its messages. */
interface Held {
  index: number;
  keys: string[];
  line: ReadReply;
}
type ReplyIndex = Record<ReadName, Map<string, Held[]>>;
const indexes = new Map<string, { index: ReplyIndex; parts: ReadReply[][] }>();

/**
 * The stored exchanges of each read by their first message's key, from the lines made by the read's current prompt
 * (its versioned name: a version changes only when the meaning does, so the digest is never matched on). Built once,
 * and again only when a file grew.
 */
export function readReplyIndex(where = READ_REPLIES) {
  const parts = readReplies(where);
  const kept = indexes.get(where);
  if (
    kept?.parts.length === parts.length &&
    kept.parts.every((p, i) => p === parts[i])
  ) {
    return kept.index;
  }
  const index = Object.fromEntries(
    (Object.keys(READS) as ReadName[]).map((r) => [
      r,
      new Map<string, Held[]>(),
    ])
  ) as ReplyIndex;
  for (const line of parts.flat()) {
    if (isPromptVersion(line.madeBy.prompt, READS[line.read].prompt)) {
      for (const [i, start] of line.starts.entries()) {
        const keys = line.messages.slice(start, line.starts[i + 1]);
        const first = keys[0] ?? "";
        index[line.read].set(first, [
          ...(index[line.read].get(first) ?? []),
          { index: i, keys, line },
        ]);
      }
    }
  }
  indexes.set(where, { index, parts });
  return index;
}

/**
 * What `read` stored for an exchange, by the keys of its messages: the newest line of the read's current prompt that lists it with exactly the
 * messages it has now (a line that read it before it grew or was filled does not match). Decides both "pending" and
 * "counted"; undefined when it was never read. An exchange the model skipped in a reply it was asked is still read.
 */
export function replyOf(
  keys: string[],
  read: ReadName,
  index = readReplyIndex()
) {
  return index[read]
    .get(keys[0] ?? "")
    ?.findLast(
      (h) =>
        h.keys.length === keys.length && h.keys.every((k, i) => k === keys[i])
    );
}

/**
 * Stores one reply line in the month file of its batch's first message (`firstAt`): the one writer of
 * memory/read-replies/ (or of a trial folder).
 */
export const storeReply = (
  line: ReadReply,
  firstAt: string,
  where = READ_REPLIES
) => appendJsonl(readReplyPath(firstAt, where), ReadReply, [line]);

/**
 * Makes each call, a few at a time, and stores its reply as given (except the voice naming, stored after `checkedVoices`), with what made it (`madeBy`), the
 * digest of the prompt's text and the keys of the messages it read. A call that fails, or a reply that is not one (an
 * object with its `exchanges` or its `summary`), stores nothing, is returned in `failed` and is asked again at the next pass.
 */
export async function makeReplies(
  asked: Asked[],
  step: Pick<
    Step,
    "ask" | "attempt" | "dir" | "keeps" | "llm" | "madeBy" | "run"
  >,
  where = READ_REPLIES
) {
  const wordings = Object.fromEntries(
    [...new Set(asked.map((a) => a.read))].map((r) => [
      r,
      promptDigestOf(
        promptText(
          READS[r].prompt,
          step.keeps(READS[r].prompt) ? [MAY_KEEP] : []
        )
      ),
    ])
  );
  let stored = 0;
  const failed: Asked[] = [];
  await inBatches(asked, step, async (one, dir) => {
    const { call, read } = one;
    const ok = await step.attempt(
      async () => {
        const { prompt } = READS[read];
        const answer = await step.ask({
          dir,
          input: call.input,
          prompt,
          reads: call.reads,
        });
        const reply = call.checked ? call.checked(answer) : answer;
        const at = clock().toISOString();
        storeReply(
          {
            at,
            madeBy: step.madeBy(prompt),
            messages: call.keys,
            promptDigest: wordings[read] as string,
            read,
            reply,
            schemaVersion: 1,
            starts: call.starts,
            ...(call.unit && { unit: call.unit }),
            ...(call.people && { people: call.people }),
          } as ReadReply,
          call.firstAt,
          where
        );
        stored += 1;
        return true;
      },
      { read }
    );
    if (!ok) {
      failed.push(one);
    }
  });
  return { failed, stored };
}
