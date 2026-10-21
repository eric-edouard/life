import { expect, test } from "bun:test";
import { log } from "../log";
import type { Extracted, Observation } from "../schema";
import { unit } from "./fixtures";
import { markedSince, reviewed } from "./nightly";

test("a daily review reached Life only when ChatGPT read `day` without error in the last 24 h", async () => {
  const now = new Date();
  log("mcp.call", { agent: "Claude-User", tool: "day" });
  log("mcp.call", { agent: "openai-mcp/1.0.0", tool: "person" });
  log("mcp.call", { agent: "openai-mcp/1.0.0", error: true, tool: "day" });
  expect(await reviewed(now)).toBe(false);
  log("mcp.call", { agent: "openai-mcp/1.0.0", tool: "day" });
  expect(await reviewed(now)).toBe(true);
  expect(await reviewed(new Date(now.getTime() + 25 * 3_600_000))).toBe(false);
});

test('each "hey Life" is listed once its unit was read since the last night, with the observations citing it', () => {
  const u = unit();
  const built = [{ messages: [], text: "", unit: u }];
  const mark = (at: string, refs: string[]) => ({
    at,
    confidence: "high",
    conversation: u.key,
    ref: refs[0] as string,
    refs,
  });
  const read = (at: string) => ({ at, unit: u.id }) as Extracted;
  const held = {
    source: { channel: "lifelog", ref: "j:2@a" },
    text: "He will vote for the stones.",
  } as Observation;
  const marks = [
    mark("2026-10-09T10:05:00.000Z", ["j:1@a", "j:2@a"]),
    mark("2026-10-09T10:10:00.000Z", ["j:3@a"]),
  ];
  const since = "2026-10-10T02:00:00.000Z";
  expect(
    markedSince(marks, built, [read("2026-10-10T13:00:00.000Z")], since, [
      held,
    ]).map((m) => m.relation)
  ).toEqual([
    "Shop repairs → He will vote for the stones.",
    "Shop repairs → nothing held",
  ]);
  // Read before the last night, or not read yet: not listed again.
  expect(
    markedSince(marks, built, [read("2026-10-09T13:00:00.000Z")], since, [held])
  ).toEqual([]);
  expect(
    markedSince(marks, [], [read("2026-10-10T13:00:00.000Z")], since, [held])
  ).toEqual([]);
});
