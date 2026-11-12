import { expect, test } from "bun:test";
import type { SourceEvent } from "../records/source";
import {
  type MoveRate,
  moveRatesOf,
  placeAmong,
  seenExchanges,
  type Thing,
  votesOf,
} from "./move-rates";
import type { Code, Move, ReadName, SeenExchange, Side } from "./moves";

const READS: ReadName[] = ["conflict", "connection", "mentions"];
const move = (by: Side, code: Code, extra: Partial<Move> = {}): Move => ({
  at: "2026-10-05T12:00:00.000Z",
  by,
  code,
  line: 0,
  quote: "x",
  ...extra,
});
let count = 0;
const nextKey = () => {
  count += 1;
  return `whatsapp|${count}`;
};
/** An exchange every read saw, both sides wrote in, in October 2026. */
const exchange = (
  moves: Move[] = [],
  extra: Partial<SeenExchange> = {}
): SeenExchange => ({
  at: "2026-10-05T12:00:00.000Z",
  key: nextKey(),
  moves,
  reads: new Set(READS),
  source: "whatsapp",
  tone: {},
  took: new Set<Side>(["me", "them"]),
  ...extra,
});
const rowOf = (rows: MoveRate[], thing: Thing, side?: Side, source?: string) =>
  rows.find((r) => r.thing === thing && r.side === side && r.source === source);
const many = (n: number, make: () => SeenExchange) =>
  Array.from({ length: n }, make);
const NOVEMBER = "2026-11";

test("two moves of one code count once; a mention counts per person talked about", () => {
  const votes = votesOf([
    move("me", "shares"),
    move("me", "shares"),
    move("them", "shares"),
    move("me", "mention", { who: "Marc" }),
    move("me", "mention", { who: "MARC" }),
    move("me", "mention", { who: "Ana" }),
  ]);
  expect(votes.map((m) => [m.by, m.code, m.who])).toEqual([
    ["me", "shares", undefined],
    ["them", "shares", undefined],
    ["me", "mention", "Marc"],
    ["me", "mention", "Ana"],
  ]);
  const rows = moveRatesOf(
    [exchange([move("me", "shares"), move("me", "shares")])],
    NOVEMBER
  );
  expect(rowOf(rows, "shares", "me", "whatsapp")?.all).toEqual({
    n: 1,
    of: 1,
    says: "too few",
  });
});

test("an exchange a side did not write in is no chance for that side; two sources are never pooled", () => {
  const rows = moveRatesOf(
    [
      exchange([move("me", "shares")], { took: new Set<Side>(["me"]) }),
      exchange([move("me", "shares")], { source: "imessage" }),
      exchange([], { source: "imessage" }),
    ],
    NOVEMBER
  );
  expect(rowOf(rows, "shares", "them", "whatsapp")).toBeUndefined();
  expect(rowOf(rows, "shares", "me", "whatsapp")?.all).toMatchObject({
    n: 1,
    of: 1,
  });
  expect(rowOf(rows, "shares", "me", "imessage")?.all).toMatchObject({
    n: 1,
    of: 2,
  });
  expect(rowOf(rows, "shares", "me")).toBeUndefined();
});

test("a conflict code ignores the exchanges the conflict read did not see; a flag and a tone count over the exchanges their read saw", () => {
  const connectionOnly = new Set<ReadName>(["connection"]);
  const rows = moveRatesOf(
    [
      exchange([move("me", "fault")], { conflict: true, tension: true }),
      exchange([move("me", "fault")], {
        conflict: false,
        reads: connectionOnly,
      }),
      exchange([], {
        reads: new Set<ReadName>(["conflict"]),
        tone: { me: "warm" },
      }),
      exchange([], {
        tension: false,
        tone: { me: "warm", them: "cold" },
        took: new Set<Side>(["me"]),
      }),
    ],
    NOVEMBER
  );
  expect(rowOf(rows, "fault", "me", "whatsapp")?.all).toMatchObject({
    n: 1,
    of: 3,
  });
  expect(rowOf(rows, "conflict", undefined, "whatsapp")?.all).toMatchObject({
    n: 1,
    of: 1,
  });
  expect(rowOf(rows, "tension", undefined, "whatsapp")?.all).toMatchObject({
    n: 1,
    of: 2,
  });
  expect(rowOf(rows, "warm", "me", "whatsapp")?.all).toMatchObject({
    n: 1,
    of: 1,
  });
  // They wrote in the first only, with no tone for them; the last gives a tone for a side that wrote nothing.
  expect(rowOf(rows, "warm", "them", "whatsapp")).toBeUndefined();
});

test("an answer counts over the bids the other side made, unanswered counted", () => {
  const rows = moveRatesOf(
    [
      exchange([
        move("me", "shares", { answer: { kind: "toward", line: 1 } }),
        move("me", "shares", { answer: { kind: "away", line: 2 } }),
        move("me", "invites", { answer: { kind: "away", line: 1 } }),
        move("me", "asks_for"),
        move("me", "thanks"),
        move("them", "offers", { answer: { kind: "against", line: 3 } }),
      ]),
    ],
    NOVEMBER
  );
  const of = (thing: Thing, side: Side) => rowOf(rows, thing, side)?.all;
  // Their side met his three bids (a repeated share is one): one toward, one away, one unanswered.
  expect(of("toward", "them")).toMatchObject({ n: 1, of: 3 });
  expect(of("away", "them")).toMatchObject({ n: 1, of: 3 });
  expect(of("unanswered", "them")).toMatchObject({ n: 1, of: 3 });
  expect(of("against", "me")).toMatchObject({ n: 1, of: 1 });
});

test("steering counts only where a decision is at stake; an answer to a fault only where the other raised one", () => {
  const rows = moveRatesOf(
    [
      exchange([move("me", "decides"), move("them", "directs")]),
      exchange([move("them", "directs")]),
      exchange([move("them", "engages")]),
      exchange([move("me", "fault"), move("them", "engages")]),
    ],
    NOVEMBER
  );
  expect(rowOf(rows, "directs", "them")?.all).toMatchObject({ n: 2, of: 2 });
  expect(rowOf(rows, "decides", "me")?.all).toMatchObject({ n: 1, of: 2 });
  expect(rowOf(rows, "engages", "them")?.all).toMatchObject({ n: 1, of: 1 });
  expect(rowOf(rows, "engages", "me")).toBeUndefined();
});

test("14 chances say too few, 15 say share; a code not proven keeps its counts with no share", () => {
  const shares = () => exchange([move("me", "shares"), move("me", "explores")]);
  const rate = (n: number, thing: Thing) =>
    rowOf(moveRatesOf(many(n, shares), NOVEMBER), thing, "me", "whatsapp")?.all;
  expect(rate(14, "shares")).toEqual({ n: 14, of: 14, says: "too few" });
  expect(rate(15, "shares")).toEqual({ n: 15, of: 15, says: "share" });
  expect(rate(15, "explores")).toEqual({ n: 15, of: 15, says: "exploratory" });
});

test("lately and before split on the month passed", () => {
  const at = (day: string) =>
    exchange([move("me", "shares")], { at: `${day}T12:00:00.000Z` });
  const row = rowOf(
    moveRatesOf(
      [at("2025-10-31"), at("2025-11-02"), at("2026-10-30"), at("2026-11-02")],
      NOVEMBER
    ),
    "shares",
    "me",
    "whatsapp"
  );
  expect(row?.all.of).toBe(4);
  expect(row?.before.of).toBe(1);
  expect(row?.lately.of).toBe(2);
});

test("the place among others: those above and below, ties neither, no share no place", () => {
  const share = (n: number, of = 20) => ({ n, of, says: "share" as const });
  const few = { n: 1, of: 2, says: "too few" as const };
  expect(
    placeAmong(share(10), [share(2), share(10), share(5, 10), share(15), few])
  ).toEqual({ above: 1, below: 1 });
  expect(placeAmong(few, [share(2)])).toEqual({ above: 0, below: 0 });
});

test("three reads of one exchange merge into one seen exchange; a call line is no one's writing", () => {
  const msg = (
    min: number,
    fromMe: boolean,
    extra: Partial<SourceEvent> = {}
  ): SourceEvent => ({
    at: new Date(
      Date.parse("2026-10-01T12:00:00.000Z") + min * 60_000
    ).toISOString(),
    chat: "+1",
    fromMe,
    id: `+1:${min}`,
    sender: fromMe ? "me" : "+1",
    source: "whatsapp",
    text: "x",
    ...extra,
  });
  const messages = [
    msg(0, false),
    msg(1, true, { phoneCall: { seconds: 0, video: false } }),
    msg(1000, true),
  ];
  const starts = [0, 2];
  const checked = (at: number, extra = {}) => ({
    conflict: undefined,
    exchange: at,
    moves: [move("them", "shares")],
    tension: undefined,
    tone: {},
    ...extra,
  });
  const seen = seenExchanges([
    {
      checked: [checked(0, { tension: true, tone: { them: "warm" } })],
      messages,
      read: "connection",
      starts,
    },
    {
      checked: [checked(0, { conflict: false })],
      messages,
      read: "conflict",
      starts,
    },
    { checked: [checked(0), checked(2)], messages, read: "mentions", starts },
  ]);
  expect(
    seen.map((x) => [x.key, x.moves.length, [...x.reads].sort(), [...x.took]])
  ).toEqual([
    ["whatsapp|+1:0", 3, ["conflict", "connection", "mentions"], ["them"]],
    ["whatsapp|+1:1000", 1, ["mentions"], ["me"]],
  ]);
  expect([seen[0]?.tension, seen[0]?.conflict, seen[0]?.tone]).toEqual([
    true,
    false,
    { me: undefined, them: "warm" },
  ]);
});
