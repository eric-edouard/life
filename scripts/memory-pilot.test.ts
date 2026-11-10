import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceEvent } from "@life/server/src/records/source";
import { asksOf, checkedMoves, countsOf, readAll } from "./memory-pilot";

const SECOND_LINE = /^\[1\] \d\d:\d\d me: bravo$/;
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
const replyOf = (moves: unknown[]) => ({
  exchanges: [
    { exchange: 0, moves, tension: false, tone: { me: "warm", them: "warm" } },
  ],
});

test("a move is kept with the words of its line, who wrote it and when; what is not in the words is dropped", () => {
  const { dropped, exchanges, offLine } = checkedMoves(
    replyOf([
      {
        answer: { kind: "toward", line: 1 },
        code: "good_news",
        line: 0,
        quote: "J'AI EU LE POSTE",
      },
      // A short line is quoted whole, whatever the reply quoted.
      { code: "affection", line: 1, quote: "well done" },
      {
        code: "asks_for",
        line: 2,
        quote: "tu peux me prêter 200 euros",
        resource: "money",
      },
      // Dropped: words that are not there, a code that is none, a line that is none, a second vote for one code.
      { code: "thanks", line: 0, quote: "merci beaucoup pour tout" },
      { code: "flatters", line: 0, quote: "j'ai eu le poste" },
      { code: "thanks", line: 9, quote: "bravo" },
      { code: "affection", line: 2, quote: "tu peux me prêter 200 euros" },
    ]),
    talk
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
    {
      at: talk[2]?.at,
      by: "me",
      code: "asks_for",
      line: 2,
      quote: "tu peux me prêter 200 euros",
      resource: "money",
    },
  ]);
  expect([dropped, offLine]).toEqual([4, 0]);
});

test("a quote found on another line moves there and is counted; a reply that is not one throws", () => {
  const { exchanges, offLine } = checkedMoves(
    replyOf([
      {
        code: "asks_for",
        line: 0,
        quote: "prêter 200 euros",
        resource: "money",
      },
    ]),
    talk
  );
  expect(exchanges[0]?.moves.map((m) => [m.line, m.by])).toEqual([[2, "me"]]);
  expect(offLine).toBe(1);
  expect(() => checkedMoves({ moves: [] }, talk)).toThrow();
});

test("a call per batch of a chat both sides wrote in; a reply is kept under the wording that made it, and never asked twice", async () => {
  const events = [...talk, msg(0, false, "never answered", "+2")];
  const ana = { name: "Ana", relation: "friend" };
  const asks = asksOf(events, ana, "wording one");
  expect(asks.length).toBe(1);
  expect(asks[0]?.input.lines[0]).toBe("## Exchange 0 · 2026-10-01");
  expect(asks[0]?.input.lines[2]).toMatch(SECOND_LINE);
  expect(asksOf(events, ana, "wording two")[0]?.key).not.toBe(asks[0]?.key);

  const root = await mkdtemp(join(tmpdir(), "pilot-"));
  const kept = join(root, "kept");
  let asked = 0;
  const stepOf = (reply: unknown) => ({
    ask: () => {
      asked += 1;
      return Promise.resolve(reply);
    },
    // As a run's `attempt`: a failure costs that piece only.
    attempt: (work: () => Promise<unknown>) => work().catch(() => undefined),
    dir: join(root, "run"),
    llm: { engine: "codex", model: "test" },
    run: "r1",
  });
  try {
    expect(countsOf(asks, kept, 10)).toMatchObject({
      batches: 1,
      keptAlready: 0,
      toAsk: 1,
    });
    // A reply that is not one keeps nothing: it is asked again.
    await readAll(asks, stepOf({ nope: true }) as never, "p", kept);
    expect(existsSync(join(kept, `${asks[0]?.key}.json`))).toBe(false);
    const good = replyOf([{ code: "affection", line: 1, quote: "bravo" }]);
    const counts = await readAll(asks, stepOf(good) as never, "p", kept);
    expect(counts).toEqual({ dropped: 0, moves: 1, offLine: 0 });
    await readAll(asks, stepOf(good) as never, "p", kept);
    expect(asked).toBe(2);
    expect(countsOf(asks, kept, 10)).toMatchObject({
      keptAlready: 1,
      toAsk: 0,
      tokensAtMost: 0,
    });
    const file = await Bun.file(join(kept, `${asks[0]?.key}.json`)).json();
    expect(file.messages).toEqual([
      "whatsapp|+1:0",
      "whatsapp|+1:1",
      "whatsapp|+1:2",
    ]);
    expect(file.reply).toEqual(good);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
