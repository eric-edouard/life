import { expect, test } from "bun:test";
import { log } from "../log";
import type { Observation } from "../schema";
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

test('each "hey Life" an extract run read since the last night, with the observations citing its lines', () => {
  const mark = (at: string, refs: string[]) => ({
    at,
    confidence: "high" as const,
    quote: "hey Life, two things",
    refs,
  });
  const events = [
    {
      at: "2026-10-15T12:00:00.000Z",
      kind: "run.end",
      marks: [mark("2026-10-15T09:00:00.000Z", ["j:1@a"])],
      step: "memory.extract",
    },
    {
      at: "2026-10-16T13:00:00.000Z",
      kind: "run.end",
      marks: [mark("2026-10-16T09:00:00.000Z", ["j:2@a", "j:3@a"])],
      step: "memory.extract",
    },
    {
      at: "2026-10-16T14:00:00.000Z",
      kind: "run.end",
      marks: [mark("2026-10-16T10:00:00.000Z", ["j:4@a"])],
      step: "memory.moments",
    },
    {
      at: "2026-10-17T01:00:00.000Z",
      kind: "run.end",
      marks: [mark("2026-10-16T20:00:00.000Z", ["j:5@a"])],
      step: "memory.extract",
    },
  ];
  const held = {
    source: { channel: "lifelog", ref: "j:3@a" },
    text: "He will vote for the stones.",
  } as Observation;
  expect(
    markedSince(events, "2026-10-16T02:00:00.000Z", [held]).map(
      (m) => m.relation
    )
  ).toEqual([
    "“hey Life, two things” → He will vote for the stones.",
    "“hey Life, two things” → nothing held",
  ]);
});
