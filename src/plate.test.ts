import { expect, test } from "bun:test";
import { type Card, clientName, LIMITS, strip, toneOf, waking } from "./plate";

const now = Date.parse("2026-10-21T15:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

test("a source is red only when Life can't read it; silence is quiet, then amber past its limit", () => {
  expect(toneOf(ago(10 * 60_000), LIMITS.whatsapp, now)).toEqual({
    tone: "ok",
    word: "receiving",
  });
  expect(toneOf(ago(5 * 3_600_000), LIMITS.whatsapp, now)).toEqual({
    tone: "idle",
    word: "quiet",
  });
  expect(toneOf(ago(25 * 3_600_000), LIMITS.whatsapp, now)).toEqual({
    tone: "warn",
    word: "silent",
  });
  expect(toneOf(ago(60_000), LIMITS.whatsapp, now, false)).toEqual({
    tone: "bad",
    word: "unreadable",
  });
  expect(toneOf(null, LIMITS.mail, now)).toEqual({
    tone: "idle",
    word: "nothing yet",
  });
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

test("MCP clients go by the names he knows them by", () => {
  expect(clientName("openai-mcp/1.0.0")).toBe("ChatGPT (Atlas)");
  expect(clientName("claude-ai/0.1")).toBe("Claude");
  expect(clientName("")).toBe("unknown client");
  expect(clientName("curl/8")).toBe("curl/8");
});

test("what leaves the Mac carries none of his words: no content, no ask", () => {
  const card: Card = {
    ask: "Life's status page shows a failure: look into it.",
    content: ["Sam: see you at 8"],
    facts: [{ at: ago(0), label: "Last message" }],
    group: "sources",
    headline: "receiving",
    id: "whatsapp",
    name: "WhatsApp",
    tone: "ok",
    word: "receiving",
  };
  const plate = {
    cards: [card],
    edges: [],
    groups: [],
    observedAt: ago(0),
    problems: 0,
    today: [],
    worst: "ok" as const,
  };
  const out = strip(plate as unknown as Parameters<typeof strip>[0]);
  expect(JSON.stringify(out)).not.toContain("Sam");
  expect(out.cards[0]).not.toHaveProperty("ask");
  expect(out.cards[0]?.facts).toEqual(card.facts);
});
