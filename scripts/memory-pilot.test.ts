import { expect, test } from "bun:test";
import { callOf } from "@life/server/src/memory/exchange-reads";
import { ReadReply } from "@life/server/src/records/read-reply";
import { eventKey, type SourceEvent } from "@life/server/src/records/source";
import { checkedOf } from "./memory-pilot";

const START = Date.parse("2026-10-01T12:00:00.000Z");
const msg = (min: number, fromMe: boolean, text: string): SourceEvent => ({
  at: new Date(START + min * 60_000).toISOString(),
  chat: "+1",
  fromMe,
  id: `+1:${min}`,
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text,
});
const talk = [
  msg(0, false, "j'ai eu le poste, je commence lundi prochain à Lyon !"),
  msg(1, true, "bravo"),
  msg(2, true, "tu peux me prêter 200 euros jusqu'à vendredi prochain ?"),
];
const SECOND_LINE = /^\[1\] \d\d:\d\d me: bravo$/;

test("a call shows the exchange as numbered lines; a trial reply is checked against the messages it read", () => {
  const call = callOf([talk], { name: "Ana", relation: "friend" });
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
