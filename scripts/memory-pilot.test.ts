import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SourceEvent } from "@life/server/src/records/source";
import { callsOf, countsOf, makeCalls } from "./memory-pilot";

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
const WARM = { me: "warm", them: "warm" };
const replyOf = (moves: unknown[], exchange = 0) => ({
  exchanges: [{ exchange, moves, tension: false, tone: WARM }],
});

test("a call per batch of a chat both sides wrote in; a reply is kept under the wording that made it, and never asked twice", async () => {
  const events = [...talk, msg(0, false, "never answered", "+2")];
  const ana = { name: "Ana", relation: "friend" };
  const calls = callsOf(events, ana, "wording one");
  expect(calls.length).toBe(1);
  expect(calls[0]?.input.lines[0]).toBe("## Exchange 0 · 2026-10-01");
  expect(calls[0]?.input.lines[2]).toMatch(SECOND_LINE);
  expect(callsOf(events, ana, "wording two")[0]?.key).not.toBe(calls[0]?.key);

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
  const make = (reply: unknown, list = calls) =>
    makeCalls(list, stepOf(reply) as never, "p", "wording one", kept);
  try {
    expect(countsOf(calls, kept, "wording one")).toMatchObject({
      batches: 1,
      keptAlready: 0,
      toAsk: 1,
    });
    // A reply that is not one keeps nothing: it is asked again.
    await make({ nope: true });
    expect(existsSync(join(kept, `${calls[0]?.key}.json`))).toBe(false);
    const good = replyOf([{ code: "affection", line: 1, quote: "bravo" }]);
    // The same call twice in one pass (one person named twice) is made once.
    expect(await make(good, [...calls, ...calls])).toEqual({
      dropped: 0,
      missing: 0,
      moves: 1,
      offLine: 0,
    });
    await make(good);
    expect(asked).toBe(2);
    expect(countsOf(calls, kept, "wording one")).toMatchObject({
      keptAlready: 1,
      toAsk: 0,
      tokensAtMost: 0,
    });
    const file = await Bun.file(join(kept, `${calls[0]?.key}.json`)).json();
    expect(file.messages).toEqual([
      "whatsapp|+1:0",
      "whatsapp|+1:1",
      "whatsapp|+1:2",
    ]);
    expect([file.reply, file.starts]).toEqual([good, [0]]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
