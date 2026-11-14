import { expect, test } from "bun:test";
import { ReadReply } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import { directCallOf } from "./exchange-reads";
import { checkedMoves, checkedOf } from "./moves";

const START = Date.parse("2026-10-01T12:00:00.000Z");
const msg = (
  min: number,
  fromMe: boolean,
  text: string,
  chat = "+1"
): SourceEvent => ({
  at: new Date(START + min * 60_000).toISOString(),
  chat,
  fromMe,
  id: `${chat}:${min}`,
  sender: fromMe ? "me" : chat,
  source: "whatsapp",
  text,
});
const talk = [
  msg(0, false, "j'ai eu le poste, je commence lundi prochain à Lyon !"),
  msg(1, true, "bravo"),
  msg(2, true, "tu peux me prêter 200 euros jusqu'à vendredi prochain ?"),
];
const WARM = { me: "warm", them: "warm" };
const replyOf = (moves: unknown[], exchange = 0) => ({
  exchanges: [{ exchange, moves, tension: false, tone: WARM }],
});
const ASKS = {
  code: "asks_for",
  line: 2,
  quote: "tu peux me prêter 200 euros",
  resource: "money",
};

test("a move is kept with the words of its line, who wrote it and when; what is not in the words is dropped", () => {
  const { dropped, exchanges, missing, offLine } = checkedMoves(
    replyOf([
      {
        answer: { kind: "toward", line: 1 },
        code: "good_news",
        line: 0,
        quote: "J'AI EU LE POSTE",
      },
      // A quote too short for the quote check holds when it is on its short line, which is then quoted whole.
      { code: "affection", line: 1, quote: "Bravo" },
      ASKS,
      // Dropped: words not in the exchange, words not on a short line, a code that is none, a line that is none.
      { code: "thanks", line: 0, quote: "merci beaucoup pour tout" },
      { code: "thanks", line: 1, quote: "well done" },
      { code: "flatters", line: 0, quote: "j'ai eu le poste" },
      { code: "thanks", line: 9, quote: "bravo" },
      { code: "affection", line: 2, quote: "tu peux me prêter 200 euros" },
    ]),
    talk,
    [0]
  );
  expect(exchanges[0]?.moves as unknown).toEqual([
    {
      answer: { kind: "toward", line: 1 },
      at: talk[0]?.at,
      by: "them",
      code: "good_news",
      line: 0,
      quote: "j'ai eu le poste",
    },
    { at: talk[1]?.at, by: "me", code: "affection", line: 1, quote: "bravo" },
    { ...ASKS, at: talk[2]?.at, by: "me" },
    // A second move of one code by one person is kept: every move counts for the rates.
    {
      at: talk[2]?.at,
      by: "me",
      code: "affection",
      line: 2,
      quote: "tu peux me prêter 200 euros",
    },
  ]);
  expect([dropped, missing, offLine]).toEqual([4, 0, 0]);
});

test("a quote found on another line of its exchange moves there and is counted; an answer must be the other side's, later", () => {
  const { exchanges, offLine } = checkedMoves(
    replyOf([
      {
        answer: { kind: "toward", line: 2 },
        code: "asks_for",
        line: 0,
        quote: "prêter 200 euros",
        resource: "money",
      },
    ]),
    talk,
    [0]
  );
  expect(exchanges[0]?.moves.map((m) => [m.line, m.by, m.answer])).toEqual([
    [2, "me", undefined],
  ]);
  expect(offLine).toBe(1);
});

test("a move stays inside its exchange; an exchange the batch does not hold is missing; a call line carries no move; a reply that is not one throws", () => {
  const call: SourceEvent = {
    ...msg(3, false, ""),
    phoneCall: { seconds: 0, video: false },
  };
  // Two exchanges: lines 0 to 1, then 2 to 3.
  const batch = [...talk, call];
  const { exchanges, missing } = checkedMoves(
    {
      exchanges: [
        // Its quote is in the other exchange: dropped, not moved there.
        {
          exchange: 0,
          moves: [{ ...ASKS, line: 1 }],
          tension: false,
          tone: { me: null, them: "icy" },
        },
        {
          exchange: 2,
          moves: [
            // A call is never an answer either.
            { ...ASKS, answer: { kind: "toward", line: 3 } },
            { code: "shares", line: 3, quote: "audio call" },
          ],
          tension: true,
          tone: WARM,
        },
        { exchange: 7, moves: [], tension: false, tone: WARM },
      ],
    },
    batch,
    [0, 2]
  );
  expect(exchanges.map((x) => x.moves.map((m) => [m.code, m.answer]))).toEqual([
    [],
    [["asks_for", undefined]],
  ]);
  expect(missing).toBe(0);
  expect(checkedMoves(replyOf([], 7), batch, [0, 2]).missing).toBe(2);
  expect(() => checkedMoves({ moves: [] }, talk, [0])).toThrow();
});

test("two people talked about on one line are two mentions", () => {
  const line = [msg(0, false, "Marc et Julie ont annulé au dernier moment")];
  const mention = (who: string) => ({
    code: "mention",
    kind: "fact",
    line: 0,
    purpose: "complains",
    quote: "Marc et Julie ont annulé",
    reported: false,
    scope: "act",
    tone: "negative",
    who,
  });
  const { exchanges } = checkedMoves(
    replyOf([mention("Marc"), mention("Julie"), mention("Marc")]),
    line,
    [0],
    "mentions"
  );
  expect(exchanges[0]?.moves.map((m) => m.who)).toEqual(["Marc", "Julie"]);
});

test("a move whose resource is `standing` (praise, respect) parses: the stored replies carry it", () => {
  const { dropped, exchanges } = checkedMoves(
    replyOf([{ code: "gives", line: 1, quote: "Bravo", resource: "standing" }]),
    talk,
    [0]
  );
  expect(dropped).toBe(0);
  expect(exchanges[0]?.moves).toHaveLength(1);
});

const SECOND_LINE = /^\[1\] \d\d:\d\d me: bravo$/;

test("a call shows the exchange as numbered lines; a trial reply is checked against the messages it read", () => {
  const call = directCallOf([talk], { name: "Ana", relation: "friend" });
  expect(call.input.lines[0]).toBe("## Exchange 0 · 2026-10-01");
  expect(call.input.lines[2]).toMatch(SECOND_LINE);
  expect(call.starts).toEqual([0]);

  const reply = {
    exchanges: [
      {
        exchange: 0,
        moves: [{ code: "affection", line: 1, quote: "bravo" }],
        tension: false,
        tone: { me: "warm", them: "warm" },
      },
    ],
  };
  const line = ReadReply.parse({
    at: "2026-10-02T00:00:00.000Z",
    madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
    messages: call.messages.map(eventKey),
    promptDigest: "a".repeat(16),
    read: "connection",
    reply,
    schemaVersion: 1,
    starts: call.starts,
  });
  expect(line.messages).toEqual([
    "whatsapp|+1:0",
    "whatsapp|+1:1",
    "whatsapp|+1:2",
  ]);
  const events = new Map(talk.map((e) => [eventKey(e), e]));
  const checked = checkedOf([line], "connection", events);
  expect([...checked.keys()]).toEqual(["whatsapp|+1:0"]);
  expect(checked.get("whatsapp|+1:0")?.moves.map((m) => m.code)).toEqual([
    "affection",
  ]);
  // A line that read a message no longer there is left out.
  expect(checkedOf([line], "connection", new Map()).size).toBe(0);
  expect(checkedOf([line], "mentions", events).size).toBe(0);
});

const spoken = (
  n: number,
  who: string,
  text: string,
  over: Partial<SourceEvent> = {}
): SourceEvent => ({
  ...msg(n, who === "me", text, "room"),
  sender: who,
  ...over,
});
const speakerOf = (e: SourceEvent) => (e.fromMe ? "me" : e.sender);
// Two earlier lines (0, 1), then one exchange of three (2, 3, 4) with a call line among them.
const group = [
  spoken(0, "me", "Léa a annulé"),
  spoken(1, "Ana", "ok"),
  spoken(2, "Bo", "elle abuse"),
  spoken(3, "me", "ça me saoule", {}),
  spoken(4, "Ana", "(call)", { phoneCall: { video: false } }),
];
const MENTION = {
  code: "mention",
  kind: "judgement",
  purpose: "complains",
  reported: false,
  scope: "act",
  tone: "negative",
  who: "elle",
};
const moveAt = (over: Record<string, unknown>) => ({
  ...MENTION,
  line: 2,
  quote: "elle abuse",
  ...over,
});
const checkedGroup = (moves: unknown[], tone: unknown = {}) =>
  checkedMoves(
    { exchanges: [{ exchange: 2, moves, tone }] },
    group,
    [2],
    "mentions",
    speakerOf
  );

test("`aimedAt` is kept for `me`, `all` or another speaker of the call, and dropped for the move's own speaker, a name no line carries, or when the call names no speakers", () => {
  const aimed = (to: string | null) =>
    checkedGroup([moveAt({ aimedAt: to })]).exchanges[0]?.moves[0]?.aimedAt;
  expect(aimed("me")).toBe("me");
  expect(aimed("all")).toBe("all");
  expect(aimed("Ana")).toBe("Ana");
  expect(aimed("Bo")).toBeUndefined();
  expect(aimed("Cy")).toBeUndefined();
  expect(aimed(null)).toBeUndefined();
  const without = checkedMoves(
    { exchanges: [{ exchange: 2, moves: [moveAt({ aimedAt: "me" })] }] },
    group,
    [2],
    "mentions"
  );
  expect(without.exchanges[0]?.moves[0]?.aimedAt).toBeUndefined();
});

test("a pick's `namedOn` is kept for an earlier line shown to the call or of the move's own exchange, and dropped for itself, a later line or a call line", () => {
  const named = (n: number, ref = "person:lea") =>
    checkedGroup([moveAt({ namedOn: n, ref })]).exchanges[0]?.moves[0];
  expect(named(0)).toMatchObject({ namedOn: 0, ref: "person:lea" });
  const second = checkedGroup([
    moveAt({ line: 3, namedOn: 2, quote: "ça me saoule" }),
  ]).exchanges[0]?.moves[0];
  expect(second?.namedOn).toBe(2);
  expect(named(2)?.namedOn).toBeUndefined();
  expect(named(3)?.namedOn).toBeUndefined();
  expect(named(9)?.namedOn).toBeUndefined();
  // The pick is kept as given; only its line is checked.
  expect(named(9)?.ref).toBe("person:lea");
  const callLine = checkedGroup([
    moveAt({ line: 3, namedOn: 4, quote: "ça me saoule" }),
  ]).exchanges[0]?.moves[0];
  expect(callLine?.namedOn).toBeUndefined();
});

test("a move on a line before the first exchange is refused", () => {
  const { dropped, exchanges } = checkedGroup([
    moveAt({ line: 0, quote: "Léa a annulé" }),
    moveAt({}),
  ]);
  expect(dropped).toBe(1);
  expect(exchanges[0]?.moves.map((m) => m.line)).toEqual([2]);
});

test("tone is one entry per speaker; `them` is the reply's, else the one other speaker's", () => {
  const toneOf = (tone: unknown) => checkedGroup([], tone).exchanges[0]?.tone;
  expect(toneOf({ Bo: "cold", me: "warm" })).toEqual({
    me: "warm",
    them: "cold",
  });
  expect(toneOf({ Bo: "cold", me: "warm", them: "neutral" })?.them).toBe(
    "neutral"
  );
  expect(toneOf({ Ana: "cold", Bo: "warm", me: "warm" })?.them).toBeUndefined();
  expect(toneOf({ me: "hot" })).toEqual({ me: undefined, them: undefined });
  expect(toneOf("warm")).toEqual({ me: undefined, them: undefined });
});
