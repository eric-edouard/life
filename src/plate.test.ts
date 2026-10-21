import { expect, test } from "bun:test";
import { clientName } from "./events";
import { type Card, strip, toneOf, waking } from "./plate";

const now = Date.parse("2026-10-21T15:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();
const DAY = 86_400_000;

test("a source is red only when Life can't read it; silence is quiet, then amber past its limit", () => {
  expect(toneOf(ago(10 * 60_000), DAY, now)).toEqual({
    tone: "ok",
    word: "receiving",
  });
  expect(toneOf(ago(5 * 3_600_000), DAY, now)).toEqual({
    tone: "idle",
    word: "quiet",
  });
  expect(toneOf(ago(25 * 3_600_000), DAY, now)).toEqual({
    tone: "warn",
    word: "silent",
  });
  expect(toneOf(ago(60_000), DAY, now, false)).toEqual({
    tone: "bad",
    word: "unreadable",
  });
  expect(toneOf(null, DAY, now)).toEqual({ tone: "idle", word: "nothing yet" });
});

test("the Pendant is expected to hear him between 08:00 and 01:00 only", () => {
  const at = (h: number) => new Date(2026, 9, 21, h, 30);
  expect([7, 8, 13, 23, 0, 1, 4].map((h) => waking(at(h)))).toEqual([
    false,
    true,
    true,
    true,
    true,
    false,
    false,
  ]);
});

test("connector clients go by the names he knows them by", () => {
  expect(clientName("openai-mcp/1.0.0")).toBe("ChatGPT (Atlas)");
  expect(clientName("claude-ai/0.1")).toBe("Claude");
  expect(clientName("")).toBe("unknown client");
  expect(clientName("curl/8")).toBe("curl/8");
});

test("what leaves the Mac carries none of his words and no error's text: only the listed fields", () => {
  const card: Card = {
    ask: "Life's status page shows a failure: look into it.",
    content: ["Sam: see you at 8", "Error: SQLITE_CANTOPEN /Users/x/chat.db"],
    facts: [{ at: ago(0), label: "Last item" }],
    group: "sources",
    headline: "unreadable",
    id: "imessage",
    name: "iMessage",
    tone: "bad",
    word: "unreadable",
  };
  const plate = {
    cards: [card],
    edges: [],
    groups: [],
    observedAt: ago(0),
    problems: 1,
    today: [
      {
        at: ago(0),
        detail: "codex said: Sam owes 40",
        label: "memory.extract failed",
        tone: "bad" as const,
      },
    ],
    worst: "bad" as const,
  };
  const out = JSON.stringify(
    strip(plate as unknown as Parameters<typeof strip>[0])
  );
  for (const words of ["Sam", "SQLITE", "look into it"]) {
    expect(out).not.toContain(words);
  }
  expect(out).toContain("memory.extract failed");
  expect(out).toContain("Last item");
});
