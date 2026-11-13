import { expect, test } from "bun:test";
import { HOUR } from "../core/clock";
import type { SourceEvent } from "../records/source";
import {
  EXCHANGE_ENDS_AFTER,
  exchangesOf,
  isFinished,
  isTwoWay,
} from "./exchanges";

const START = Date.parse("2026-10-01T22:00:00.000Z");
const msg = (ms: number, fromMe = false): SourceEvent => ({
  at: new Date(START + ms).toISOString(),
  chat: "+1",
  fromMe,
  id: String(ms),
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text: "x",
});
const sizes = (list: SourceEvent[]) => exchangesOf(list).map((x) => x.length);

test("a talk that crosses midnight is one exchange, in time order whatever the order given", () => {
  const late = [msg(3 * HOUR), msg(0, true), msg(1 * HOUR)];
  expect(exchangesOf(late).map((x) => x.map((e) => e.id))).toEqual([
    ["0", String(HOUR), String(3 * HOUR)],
  ]);
});

test("nothing written for the quiet ends an exchange: the very next message opens a new one", () => {
  expect(sizes([msg(0), msg(EXCHANGE_ENDS_AFTER - 1)])).toEqual([2]);
  expect(sizes([msg(0), msg(EXCHANGE_ENDS_AFTER)])).toEqual([1, 1]);
});

test("an exchange is finished once nothing was written for the quiet, counted from its last message", () => {
  const talk = exchangesOf([msg(0), msg(HOUR, true)])[0] ?? [];
  const at = (ms: number) => new Date(START + HOUR + ms);
  expect(isFinished(talk, at(EXCHANGE_ENDS_AFTER - 60_000))).toBe(false);
  expect(isFinished(talk, at(EXCHANGE_ENDS_AFTER))).toBe(true);
});

test("the quiet counts from the last message, not from the exchange's start", () => {
  expect(sizes([msg(0), msg(5 * HOUR), msg(10 * HOUR)])).toEqual([3]);
});

test("the persona's prompt says the quiet in words: changing one without the other fails here", async () => {
  const prompt = await Bun.file(
    `${import.meta.dir}/../../../../prompts/memory-persona.v2.md`
  ).text();
  expect(prompt).toContain(`${EXCHANGE_ENDS_AFTER / HOUR} hours`);
});

test("no message, no exchange", () => {
  expect(exchangesOf([])).toEqual([]);
});

test("a chat is two-way when both sides wrote in it", () => {
  expect(isTwoWay([msg(0), msg(1, true)])).toBe(true);
  expect(isTwoWay([msg(0), msg(1)])).toBe(false);
  expect(isTwoWay([msg(0, true)])).toBe(false);
});
