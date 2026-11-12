import { expect, test } from "bun:test";
import type { SourceEvent } from "../records/source";
import { checkedMoves } from "./moves";

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
