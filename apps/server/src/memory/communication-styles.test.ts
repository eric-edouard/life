import { expect, test } from "bun:test";
import type { SourceEvent } from "../records/source";
import {
  communicationStyleBlock,
  isDue,
  sampleOf,
  styleLines,
} from "./communication-styles";

const sent = (i: number, source: "whatsapp" | "mail"): SourceEvent => ({
  at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
  chat: "+1",
  fromMe: true,
  id: `${source}:${i}`,
  sender: "me",
  source,
  text: `m${i}`,
});

test("a sample is his newest 120 chat messages and 30 mails, oldest first", () => {
  const events = [
    ...Array.from({ length: 130 }, (_, i) => sent(i, "whatsapp")),
    ...Array.from({ length: 40 }, (_, i) => sent(i, "mail")),
  ].toReversed();
  const { chat, mail } = sampleOf(events);
  expect(chat.map((m) => m.text)).toEqual(
    Array.from({ length: 120 }, (_, i) => `m${i + 10}`)
  );
  expect(mail).toHaveLength(30);
  expect(mail[0]?.text).toBe("m10");
});

test("an example stays only as his own words in a chat message he was shown; a bad line goes, an app he never wrote in too", () => {
  const sample = {
    chat: [
      {
        at: "2026-10-01 10:00",
        source: "whatsapp" as const,
        text: "Ok ça marche, à demain !! 😘",
      },
    ],
    mail: [],
  };
  const reply = {
    lines: [
      {
        examples: ["ok ca marche", "Bien à vous"],
        kind: "chat",
        source: "whatsapp",
        text: "Short, warm, no capitals.",
      },
      { examples: [], kind: "fax", text: "Not a kind." },
      {
        examples: [],
        kind: "chat",
        source: "line",
        text: "No LINE in the sample.",
      },
    ],
  };
  expect(styleLines(reply, sample)).toEqual([
    {
      examples: ["Ok ça marche"],
      kind: "chat",
      source: "whatsapp",
      text: "Short, warm, no capitals.",
    },
    { examples: [], kind: "chat", text: "No LINE in the sample." },
  ]);
  expect(styleLines("not json", sample)).toEqual([]);
});

test("a style is rebuilt when there is none, or a week old with new messages", () => {
  const now = new Date("2026-11-08T00:00:00.000Z");
  const last = { built: "2026-11-05T00:00:00.000Z", inputs: "a" };
  expect(isDue(null, "a", now)).toBe(true);
  expect(isDue(last, "b", now)).toBe(false);
  expect(isDue({ ...last, built: "2026-11-01T00:00:00.000Z" }, "b", now)).toBe(
    true
  );
  expect(isDue({ ...last, built: "2026-11-01T00:00:00.000Z" }, "a", now)).toBe(
    false
  );
});

test("a reader shows each line with its channel and examples", () => {
  expect(
    communicationStyleBlock("Communication style", [
      { examples: [], kind: null, text: "French, tu, first name." },
      {
        examples: ["haha ok"],
        kind: "chat",
        source: "linkedin",
        text: "Short.",
      },
    ])
  ).toEqual([
    "Communication style (how he writes, read weekly from his latest messages; follow it when drafting for him):",
    "- general: French, tu, first name.",
    '- chat (linkedin): Short. E.g. "haha ok"',
    "",
  ]);
});
