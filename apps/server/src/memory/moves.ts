import { z } from "zod";
import { type ReadName, ReadReply } from "../records/read-reply";
import type { SourceEvent } from "../records/source";
import { folded, locate } from "./observe";
import { checkedEntries } from "./run";
import { textOf } from "./units";

// The moves a model lists when it reads an exchange: their shapes by read, and the code that checks a reply's moves
// against the messages. Never stored: the replies are (`memory/exchange-reads.ts`), the moves are worked out when read.

const RESOURCES = [
  "affection",
  "standing",
  "information",
  "money",
  "goods",
  "service",
] as const;
const cited = { line: z.int().min(0), quote: z.string() };
const PLAIN_BIDS = [
  "shares",
  "good_news",
  "support_asked",
  "invites",
  "reassurance_asked",
] as const;
const RESOURCE_BIDS = ["asks_for", "offers"] as const;
/** The codes of a bid: a move that invites an answer, so its shape holds `answer` (kind and line). */
export const BIDS = [...PLAIN_BIDS, "discloses", ...RESOURCE_BIDS] as const;
const bid = {
  ...cited,
  answer: z
    .object({
      kind: z.enum(["toward", "away", "against"]),
      line: z.int().min(0),
    })
    .nullish(),
};
/** A move of the connection read, by its code: what each carries beside its line and its quote. */
const ConnectionMove = z.discriminatedUnion("code", [
  z.object({
    code: z.enum(PLAIN_BIDS),
    ...bid,
  }),
  z.object({
    code: z.literal("discloses"),
    depth: z.int().min(1).max(3),
    ...bid,
  }),
  z.object({
    code: z.enum(RESOURCE_BIDS),
    resource: z.enum(RESOURCES),
    ...bid,
  }),
  z.object({
    code: z.enum(["gives", "refuses", "returns"]),
    resource: z.enum(RESOURCES),
    ...cited,
  }),
  z.object({
    code: z.enum([
      "asks_about",
      "thanks",
      "affection",
      "support_given",
      "explores",
    ]),
    ...cited,
  }),
]);
/** A move of the mentions read: someone not in the conversation talked about, or what a writer says of their own mind. */
const MentionsMove = z.discriminatedUnion("code", [
  z.object({
    code: z.literal("mention"),
    kind: z.enum(["fact", "judgement"]),
    purpose: z.enum([
      "informs",
      "plans",
      "complains",
      "praises",
      "worries",
      "asks_advice",
      "jokes",
    ]),
    reported: z.boolean(),
    scope: z.enum(["act", "person"]),
    tone: z.enum(["positive", "neutral", "negative"]),
    who: z.string().min(1).max(80),
    ...cited,
  }),
  z.object({
    code: z.literal("feels"),
    valence: z.enum(["positive", "negative"]),
    ...cited,
  }),
  z.object({ code: z.enum(["intends", "wants", "believes"]), ...cited }),
]);
const Strength = z.int().min(1).max(3);
/** A move of the conflict read: friction, the answer to a fault (`to`: the line it answers), and who steers. */
const ConflictMove = z.discriminatedUnion("code", [
  z.object({
    code: z.enum(["fault", "contempt", "presses"]),
    strength: Strength,
    ...cited,
  }),
  z.object({
    code: z.literal("blames"),
    on: z.enum(["other", "self", "third", "circumstances"]),
    ...cited,
  }),
  z.object({
    code: z.literal("apologises"),
    parts: z.array(z.enum(["admits", "regret", "repair"])).default([]),
    to: z.int().min(0).nullish(),
    ...cited,
  }),
  z.object({
    code: z.enum([
      "engages",
      "excuses",
      "denies",
      "counters",
      "yields",
      "moves_on",
    ]),
    to: z.int().min(0).nullish(),
    ...cited,
  }),
  z.object({
    code: z.enum(["distress", "directs", "proposes", "defers", "decides"]),
    ...cited,
  }),
]);
/** The shape of each read's moves, by its name. */
export const MOVES = {
  conflict: ConflictMove,
  connection: ConnectionMove,
  mentions: MentionsMove,
} satisfies Record<ReadName, z.ZodType>;
type Listed = z.infer<(typeof MOVES)[ReadName]>;
/** The code of a move, of any read. */
export type Code = Listed["code"];
/** Whose words: the owner's (`me`) or the other person's (`them`). */
export type Side = "me" | "them";
/** A move as code checks it: its words found on their line, who wrote it and when from the message, its answer or the line it answers kept only when valid. */
export type Move = Pick<Listed, "line" | "quote"> & {
  answer?: { kind: "toward" | "away" | "against"; line: number };
  at: string;
  by: Side;
  code: Code;
  to?: number;
  who?: string;
};
/** One exchange of a checked reply: its moves, and the flags and the tone of each side the read gave. */
export type CheckedExchange = ReturnType<
  typeof checkedMoves
>["exchanges"][number];
const Tone = z.enum(["warm", "neutral", "cold"]).nullish().catch(undefined);
/** One exchange of a reply; its moves are checked one by one (`movesOf`). Each read fills the flags it is asked for. */
const ExchangeEntry = z.object({
  conflict: z.boolean().optional(),
  exchange: z.int().min(0),
  moves: z.array(z.unknown()),
  tension: z.boolean().optional(),
  // A tone that is none of the three is no tone: it never costs the exchange its moves.
  tone: z.object({ me: Tone, them: Tone }).catch({}),
});

/** An exchange of a batch: its messages, from line `start` of the batch. */
interface Span {
  end: number;
  messages: SourceEvent[];
  start: number;
}

/**
 * The words of a move and the line they are on, inside its exchange: the quote found there (`locate`, the cited line
 * first), else, for a quote too short for `locate`, the cited line whole when the quote is in it.
 */
function quoted(m: Listed, span: Span) {
  const texts = span.messages.map(textOf);
  const at = m.line - span.start;
  const found = locate(m.quote, texts, at);
  if (found) {
    return { line: span.start + found.line, verbatim: found.verbatim };
  }
  const whole = texts[at] ?? "";
  const quote = folded(m.quote).out.trim();
  return quote && folded(whole).out.includes(quote)
    ? { line: m.line, verbatim: whole }
    : null;
}

/** A move's answer, kept only when it is a later line of the same exchange, written by the other side. */
function answerOf(m: Listed, line: number, by: SourceEvent, span: Span) {
  const answer =
    "answer" in m
      ? (m.answer as { kind: string; line: number } | null | undefined)
      : undefined;
  const reply = answer ? span.messages[answer.line - span.start] : undefined;
  const isTheirs = reply && !reply.phoneCall && reply.fromMe !== by.fromMe;
  return answer && isTheirs && answer.line > line ? answer : undefined;
}

/** The line a move answers (`to`), kept only when it is an earlier line of the same exchange, written by the other side. */
function answeredOf(m: Listed, line: number, by: SourceEvent, span: Span) {
  const to = "to" in m && typeof m.to === "number" ? m.to : undefined;
  const said = to === undefined ? undefined : span.messages[to - span.start];
  return said && said.fromMe !== by.fromMe && (to as number) < line
    ? to
    : undefined;
}

/**
 * The moves of one exchange code accepts: a known code, on a line of the exchange that is not a call, its words found
 * there. Every one is kept: counting what a person did once or twice is the rates' (`memory/move-rates.ts`).
 */
function movesOf(raw: unknown[], span: Span, read: ReadName) {
  const schema: z.ZodType<Listed> = MOVES[read];
  const { entries } = checkedEntries(
    raw,
    schema,
    // A line can hold a mention of each person talked about.
    (m) => `${m.line}|${m.code}|${"who" in m ? m.who : ""}`,
    (key) => {
      const line = Number.parseInt(key, 10);
      return line >= span.start && line < span.end;
    }
  );
  let offLine = 0;
  const moves = entries.flatMap((m) => {
    const found = quoted(m, span);
    const message = found ? span.messages[found.line - span.start] : undefined;
    if (!(found && message) || message.phoneCall) {
      return [];
    }
    offLine += found.line === m.line ? 0 : 1;
    return [
      {
        ...m,
        answer: answerOf(m, found.line, message, span),
        at: message.at,
        by: message.fromMe ? "me" : "them",
        line: found.line,
        quote: found.verbatim,
        to: answeredOf(m, found.line, message, span),
      } as Move,
    ];
  });
  return { dropped: raw.length - moves.length, moves, offLine };
}

/**
 * A reply's moves as code accepts them, exchange by exchange. An exchange is one the batch really holds, named by its
 * first line (`starts`), once; a move stays inside its exchange; who made it and when come from the message, never
 * from the reply. Throws on a reply that is not one. `dropped`: moves refused; `offLine`: quotes found on another
 * line of their exchange; `missing`: exchanges of the batch the reply left out or got wrong.
 */
export function checkedMoves(
  reply: unknown,
  messages: SourceEvent[],
  starts: number[],
  read: ReadName = "connection"
) {
  const spans = new Map(
    starts.map((start, i): [number, Span] => {
      const end = starts[i + 1] ?? messages.length;
      return [start, { end, messages: messages.slice(start, end), start }];
    })
  );
  const { entries } = checkedEntries(
    ReadReply.shape.reply.parse(reply).exchanges,
    ExchangeEntry,
    (x) => String(x.exchange),
    (key) => spans.has(Number(key))
  );
  const counts = {
    dropped: 0,
    missing: starts.length - entries.length,
    offLine: 0,
  };
  const exchanges = entries.map((x) => {
    const { dropped, moves, offLine } = movesOf(
      x.moves,
      spans.get(x.exchange) as Span,
      read
    );
    counts.dropped += dropped;
    counts.offLine += offLine;
    return {
      conflict: x.conflict,
      exchange: x.exchange,
      moves,
      tension: x.tension,
      tone: x.tone,
    };
  });
  return { ...counts, exchanges };
}

/** What each read gave about an exchange, by its first message's key: the unit the rates count (`memory/move-rates.ts`). */
export interface SeenExchange {
  /** Its first message's instant. */
  at: string;
  conflict?: boolean;
  /** Its first message's key (`eventKey`). */
  key: string;
  moves: Move[];
  /** The reads that listed it, so a code is counted only over the exchanges its own read saw. */
  reads: Set<ReadName>;
  /** Its first message's source: rates of an exchange chance are kept apart by it. */
  source: string;
  tension?: boolean;
  tone: { me?: string | null; them?: string | null };
  /** The sides that wrote in it; a call line is no one's writing. */
  took: Set<Side>;
}
