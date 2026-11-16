import { z } from "zod";
import { DAY } from "../core/clock";
import { newestWithin } from "../core/lists";
import { CONVERSATION_ENDS_AFTER } from "../core/quiet";
import { redact } from "../core/redact";
import { isPromptVersion } from "../models/prompt-parts";
import type { ReadReply } from "../records/read-reply";
import { SUMMARY_READ } from "../records/read-reply";
import {
  openStore,
  parseTurnRef,
  turnRef,
  withStore,
} from "../sources/lifelog";
import { readSpokenTurns } from "../sources/lifelog-conversations";
import { exchangesOf } from "./exchanges";
import { READ_REPLIES } from "./memory-files";
import { locate } from "./quote-check";
import { type Asked, makeReplies, READS, readReplies } from "./read-replies";
import { begin, chunks, type Step } from "./run";
import {
  type SpokenPart,
  type SpokenTurn,
  spokenConversationsOf,
  spokenPartsOf,
} from "./spoken-conversations";
import { clip, lifelogNames, turnKey, turnRefOf } from "./units";
import type { People } from "./who";
import { transcripts } from "./words";
import { dayStart, localDate, time } from "./zones";

// The conversation summaries (docs/glossary.md): one per long conversation recorded in person, written by a model
// from every line, stored by `memory/read-replies.ts` as one more read. What is pending and what shows is derived from
// the stored lines and lifelog's turns (their keys, `turnKey`); the night asks, behind his `conversationSummaries`
// setting, which gates the calls and never the reading of what is stored.

/** The most calls a night makes, all its passes together: a first build takes several nights, the newest first. */
export const NIGHT_CALLS = 40;
/** The night examines the conversations with a turn lifelog first brought in this long ago. */
const SEEN_WITHIN = 7 * DAY;

/** The size asked for a part of `chars` characters: 200 words per 15,000 characters, at least 300. */
export const maxWordsOf = (chars: number) =>
  Math.max(300, Math.round((chars / 15_000) * 200));

type SummaryLine = Extract<ReadReply, { read: typeof SUMMARY_READ }>;
const { prompt: PROMPT } = READS.conversation_summary;

const Subject = z.object({ label: z.string().min(1), line: z.int().min(0) });
const Quote = z.object({ line: z.int().min(0), quote: z.string().min(1) });
const Items = z.array(z.unknown()).catch([]);
const Reply = z.looseObject({
  doubts: Items,
  quotes: Items,
  subjects: Items,
  summary: z.string(),
});

/** A stored summary that shows: its first turn's ref, the instant of it, and what the model said, checked as far as the lines' numbers go. */
export interface HeldSummary {
  at: string;
  doubts: string[];
  /** The turn keys of the lines it read, in order: line `n` is key `n`. */
  keys: string[];
  /** The ref of the part that follows it in the same conversation, once that one is written. */
  next?: string;
  quotes: { line: number; quote: string }[];
  ref: string;
  /** Who else spoke in it, as lifelog named them (`personId`, `name`), each once: who they are is `heardPersonOf`'s. */
  speakers: { id: string | null; name: string | null }[];
  /** Only the subjects whose line is one of its lines. */
  subjects: { label: string; line: number }[];
  summary: string;
}

function heldOf(
  line: SummaryLine,
  turnOf: (key: string) => SpokenTurn | undefined
): HeldSummary {
  const r = Reply.parse(line.reply);
  const keys = line.messages;
  const ref = turnRefOf(keys[0] as string);
  const named = keys.flatMap((k) => {
    const t = turnOf(k);
    return t && !t.owner && (t.personId || t.name)
      ? [{ id: t.personId, name: t.name }]
      : [];
  });
  return {
    at: ref.slice(ref.indexOf("@") + 1),
    doubts: r.doubts.filter((d): d is string => typeof d === "string"),
    keys,
    quotes: r.quotes.flatMap((q) => Quote.safeParse(q).data ?? []),
    ref,
    speakers: [...new Map(named.map((v) => [`${v.id} ${v.name}`, v])).values()],
    subjects: r.subjects.flatMap((s) => {
      const o = Subject.safeParse(s).data;
      return o && o.line < keys.length ? [o] : [];
    }),
    summary: r.summary,
  };
}

/**
 * The stored summaries of the current prompt, sorted by when they start: `current` the ones that show (the newest line
 * for each of its turns, every key still equal to its turn's key in lifelog's store, which is all this reads), and the
 * `refs` of the turns of a line that lost a key (a voice given to someone else, a turn gone), so the night reads those
 * conversations again.
 */
async function heldSummaries(open = openStore, where = READ_REPLIES) {
  const lines = readReplies(where)
    .flat()
    .filter(
      (l): l is SummaryLine =>
        l.read === SUMMARY_READ && isPromptVersion(l.madeBy.prompt, PROMPT)
    );
  if (lines.length === 0) {
    return { current: [], stale: new Set<string>() };
  }
  const turns = await withStore(
    (store) => readSpokenTurns(store, new Map()),
    open
  );
  const order = new Map(turns.map((t, i) => [turnKey(t), i]));
  const talkOf = new Map(
    exchangesOf(turns, CONVERSATION_ENDS_AFTER).flatMap((c, n) =>
      c.map((t) => [turnKey(t), n] as const)
    )
  );
  // One choice for showing and for asking: a line counts when every one of its keys is still its turn's key in
  // lifelog's store; the newest such line wins over any older line sharing a turn. A line that does not count never
  // hides one that does (a voice renamed and renamed back shows the first line again).
  const sorted = lines.toSorted((a, b) => b.at.localeCompare(a.at));
  const valid = sorted.filter((l) => l.messages.every((k) => order.has(k)));
  const claimed = new Set<string>();
  const current: HeldSummary[] = [];
  for (const line of valid) {
    if (!line.messages.some((k) => claimed.has(k))) {
      current.push(heldOf(line, (k) => turns[order.get(k) ?? -1]));
    }
    for (const k of line.messages) {
      claimed.add(k);
    }
  }
  const stale = new Set<string>();
  for (const line of sorted) {
    if (
      !(
        line.messages.every((k) => order.has(k)) ||
        line.messages.some((k) => claimed.has(k))
      )
    ) {
      for (const k of line.messages) {
        stale.add(turnRefOf(k));
      }
    }
  }
  // The next part is the one of the same spoken conversation that starts soonest after this one's last turn.
  const startOf = (h: HeldSummary) => order.get(h.keys[0] as string) ?? 0;
  for (const h of current) {
    const [last, talk] = [
      order.get(h.keys.at(-1) as string) ?? 0,
      talkOf.get(h.keys[0] as string),
    ];
    h.next = current
      .filter(
        (o) => talkOf.get(o.keys[0] as string) === talk && startOf(o) > last
      )
      .toSorted((a, b) => startOf(a) - startOf(b))[0]?.ref;
  }
  return {
    current: current.toSorted((a, b) => a.at.localeCompare(b.at)),
    stale,
  };
}

/** The summaries that show now, oldest first. */
export const currentSummaries = async (
  open = openStore,
  where = READ_REPLIES
) => (await heldSummaries(open, where)).current;

/** The summary shown for a part, by the keys of its turns (the one choice that decides both what shows and what is pending). */
const summaryOfKeys = (current: HeldSummary[]) => {
  const byKeys = new Map(current.map((h) => [h.keys.join("\n"), h]));
  return (keys: string[]) => byKeys.get(keys.join("\n"));
};

/** What `fetch` opens a summary by: its part. */
export const summaryRefOf = (h: HeldSummary) =>
  `person:me/conversation/${h.ref}`;

/** A summary's text as search ranks and indexes it: its subjects, then the summary. */
export const summaryTextOf = (h: HeldSummary) =>
  `${h.subjects.map((s) => s.label).join("; ")}\n${h.summary}`;

/** A summary as a listing line (`read_day`, `search`): when, its subjects, the start of it and what opens it. */
export const summaryLine = (h: HeldSummary) =>
  `- ${localDate(h.at)} ${time(h.at)} ${h.subjects.map((s) => s.label).join("; ")}: ${clip(h.summary, 300)} (\`fetch ${summaryRefOf(h)}\`)`;

/** What the night would do: the conversations it examined as their parts, for `pendingOf`. */
export type ConversationSummaryWork = Awaited<
  ReturnType<typeof readConversationSummaryWork>
>;

/**
 * The parts of every finished spoken conversation the night examines: those with a turn lifelog first brought in the
 * last 7 days (`from`, a day: every one from then), and those of a line that lost a key. Only these fetch words.
 * `counts`: what is pending in them, before the night's cap (what a run costs).
 */
export async function readConversationSummaryWork(
  now: Date,
  people: Pick<People, "nameOf" | "resolve" | "truth">,
  o: { from?: string } = {},
  where = READ_REPLIES,
  open = openStore
) {
  const turns = await withStore(
    (store) => readSpokenTurns(store, lifelogNames(people.truth)),
    open
  );
  const { current, stale } = await heldSummaries(open, where);
  const since = o.from
    ? dayStart(o.from).toISOString()
    : new Date(now.getTime() - SEEN_WITHIN).toISOString();
  const examined = spokenConversationsOf(turns, now).filter((c) =>
    c.some(
      (t) =>
        (o.from ? t.at : (t.seen ?? "")) >= since ||
        stale.has(turnRef(t.jobId, t.turnIndex, t.at))
    )
  );
  const parts: SpokenPart[][] = [];
  for (const group of chunks(examined, 8)) {
    parts.push(
      // biome-ignore lint/performance/noAwaitInLoops: a few conversations' words at a time
      ...(await Promise.all(group.map((c) => spokenPartsOf(c, people))))
    );
  }
  const found = parts.filter((p) => p.length > 0);
  const held = summaryOfKeys(current);
  return {
    counts: {
      conversations: found.length,
      parts: found.flat().filter((p) => !held(p.keys)).length,
    },
    parts: found,
  };
}

/**
 * The calls due now: for each conversation its first part with no stored summary (a part waits for the one before it,
 * whose summary it is given), except the `skipped` (a part that failed tonight), newest first up to `cap`.
 */
function pendingOf(
  conversations: SpokenPart[][],
  held: ReturnType<typeof summaryOfKeys>,
  cap: number,
  skipped: Set<string>
) {
  const asked: Asked[] = [];
  for (const parts of conversations) {
    const k = parts.findIndex((p) => !held(p.keys));
    const part = parts[k];
    if (part && !skipped.has(part.ref)) {
      const before = parts[k - 1];
      const previous = before ? held(before.keys)?.summary : undefined;
      asked.push({
        at: part.at,
        call: {
          firstAt: part.at,
          input: {
            day: part.day,
            lines: part.lines,
            people: part.people,
            ...(previous ? { previous } : {}),
            words: maxWordsOf(part.chars),
          },
          keys: part.keys,
          starts: [0],
        },
        read: SUMMARY_READ,
      });
    }
  }
  return newestWithin(asked, cap, { at: (a) => a.at, size: () => 1 });
}

/**
 * The night's summaries: what is due (`readConversationSummaryWork`), asked and stored, again while a pass stores
 * something (a part waits for the one before it). `cap` bounds the calls of all the passes together, and a part that
 * failed is not asked again that night. A failure costs that call only.
 */
export async function conversationSummaries(
  found: ConversationSummaryWork,
  cap = NIGHT_CALLS,
  where = READ_REPLIES,
  step?: Step,
  open = openStore
) {
  const run =
    step ??
    (await begin("conversation-summaries", "main", { prompts: [PROMPT] }));
  const failed = new Set<string>();
  let [calls, stored] = [0, 0];
  for (;;) {
    const work = pendingOf(
      found.parts,
      // biome-ignore lint/performance/noAwaitInLoops: what a pass stored decides the next
      summaryOfKeys(await currentSummaries(open, where)),
      cap - calls,
      failed
    );
    const made = await makeReplies(work, run, where);
    calls += work.length;
    stored += made.stored;
    for (const f of made.failed) {
      failed.add(turnRefOf(f.call.keys[0] as string));
    }
    if (made.stored === 0) {
      break;
    }
  }
  return run.end({ calls, stored });
}

/**
 * The lines of the read part `person:me/conversation/<ref>`: the summary that starts at the turn `ref`, each subject
 * with what opens it, the quotes found on their line in lifelog's words (the others are dropped), the doubts and the
 * next part. Null when no summary shows for it.
 */
export async function conversationSummaryPart(
  ref: string,
  open = openStore,
  where = READ_REPLIES
) {
  const held = (await currentSummaries(open, where)).find((h) => h.ref === ref);
  if (!held) {
    return null;
  }
  const opens = (n: number) => `fetch ${turnRefOf(held.keys[n] as string)}`;
  let quotes: string[];
  try {
    const turns = held.keys.map((k) => parseTurnRef(turnRefOf(k)));
    const jobs = await transcripts(
      turns.flatMap((t) => (t ? [{ jobId: t.jobId }] : []))
    );
    const texts = turns.map((t) =>
      t ? redact(jobs.get(t.jobId)?.[t.turnIndex]?.text ?? "") : ""
    );
    quotes = held.quotes.flatMap((q) => {
      const found = locate(q.quote, texts, q.line);
      return found && found.line === q.line
        ? [`- "${found.verbatim}" (\`${opens(q.line)}\`)`]
        : [];
    });
  } catch (e) {
    quotes = [`(quotes not checked: ${(e as Error).message})`];
  }
  return [
    `Conversation of ${localDate(held.at)} ${time(held.at)}, written from its ${held.keys.length} lines (recorded in person):`,
    held.summary,
    "",
    "Subjects (each opens the words around it):",
    ...(held.subjects.length > 0
      ? held.subjects.map((s) => `- ${s.label} (\`${opens(s.line)}\`)`)
      : ["(none)"]),
    ...(quotes.length > 0
      ? ["", "Quotes, checked against their lines:", ...quotes]
      : []),
    ...(held.doubts.length > 0
      ? ["", "Doubts about who spoke:", ...held.doubts.map((d) => `- ${d}`)]
      : []),
    ...(held.next
      ? [
          "",
          "Next reads (`fetch <ref>`):",
          `- person:me/conversation/${held.next}: the next part of this conversation`,
        ]
      : []),
  ];
}
