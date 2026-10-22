import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  FORMATS,
  formatOf,
  importOf,
  kept,
  newestAssistant,
  pruned,
} from "./assistants";

// Made-up exports in the published shapes: claude.ai's chat_messages, ChatGPT's mapping tree.

const claudeExport = [
  {
    chat_messages: [
      {
        content: [
          { text: "My sister Ada moves to Lyon in May.", type: "text" },
        ],
        created_at: "2026-03-02T09:15:00.000Z",
        sender: "human",
        text: "My sister Ada moves to Lyon in May.",
        uuid: "m1",
      },
      {
        created_at: "2026-03-02T09:15:05.000Z",
        sender: "assistant",
        text: "That sounds like a big change.",
        uuid: "m2",
      },
      {
        content: [{ text: "Help me plan her farewell dinner.", type: "text" }],
        created_at: "2026-03-02T09:20:00.000Z",
        sender: "human",
        text: "",
        uuid: "m3",
      },
    ],
    created_at: "2026-03-02T09:15:00.000Z",
    name: "Ada's move",
    uuid: "c1",
  },
  {
    chat_messages: [
      {
        created_at: "2026-03-03T10:00:00.000Z",
        sender: "human",
        text: "Why does this fail?\n```ts\nthrow new Error()\n```",
        uuid: "m4",
      },
    ],
    name: "A bug",
    uuid: "c2",
  },
];

const node = (
  id: string,
  parent: string | null,
  role: string,
  text: string,
  extra: Record<string, unknown> = {}
) => ({
  children: [],
  id,
  message: {
    author: { role },
    content: { content_type: "text", parts: [text] },
    create_time: 1_772_000_000,
    id,
    ...extra,
  },
  parent,
});

const chatgptExport = [
  {
    conversation_id: "g1",
    create_time: 1_772_000_000,
    current_node: "u3",
    mapping: {
      a1: node("a1", "u1", "assistant", "Sure."),
      a2: node("a2", "u2b", "assistant", "Done."),
      hidden: node("hidden", "root", "user", "I am a builder in Nantes.", {
        metadata: { is_visually_hidden_from_conversation: true },
      }),
      root: { children: [], id: "root", message: null, parent: null },
      u1: node(
        "u1",
        "hidden",
        "user",
        "Draft a note to my landlord Bo about the leak."
      ),
      u2a: node("u2a", "a1", "user", "Make it shorter."),
      u2b: node("u2b", "a1", "user", "Make it warmer."),
      u3: {
        ...node("u3", "a2", "user", ""),
        message: {
          author: { role: "user" },
          content: {
            content_type: "multimodal_text",
            parts: [
              {
                content_type: "audio_transcription",
                text: "And sign it from me.",
              },
            ],
          },
          create_time: 1_772_000_100,
          id: "u3",
        },
      },
    },
    title: "Landlord note",
  },
];

test("each export reads as his messages only, on the branch he saw", () => {
  expect(formatOf(claudeExport)).toBe("claude");
  expect(formatOf(chatgptExport)).toBe("chatgpt");
  expect(formatOf([{ foo: 1 }])).toBeUndefined();
  const [ada] = FORMATS.claude.parse(claudeExport);
  // An empty `text` falls back to the content blocks; the assistant's turns are left out.
  expect(ada?.messages.map((m) => m.text)).toEqual([
    "My sister Ada moves to Lyon in May.",
    "Help me plan her farewell dinner.",
  ]);
  // The edited turn he left (u2a) is another branch; his hidden custom instructions are not a message.
  expect(
    FORMATS.chatgpt.parse(chatgptExport)[0]?.messages.map((m) => m.text)
  ).toEqual([
    "Draft a note to my landlord Bo about the leak.",
    "Make it warmer.",
    "And sign it from me.",
  ]);
});

test("pruning drops code, pasted documents, tool notices, agent briefs and repeats", () => {
  expect(kept("Call the plumber on Friday.")).toBe(true);
  expect(kept("see\n```\nls\n```")).toBe(false);
  expect(kept("Traceback (most recent call last):\n  File x")).toBe(false);
  expect(kept("<task-notification>done</task-notification>")).toBe(false);
  expect(kept("Background (from the session that started this one): …")).toBe(
    false
  );
  expect(kept("x".repeat(6001))).toBe(false);
  const doc = `${Array.from({ length: 6 }, (_, i) => `## Part ${i}\n${"word ".repeat(80)}`).join("\n")}`;
  expect(doc.length).toBeGreaterThan(2000);
  expect(kept(doc)).toBe(false);
  // A long dictated message with no structure stays.
  expect(kept("so today I talked to Ada again ".repeat(80))).toBe(true);
  const twice = pruned([
    {
      id: "a",
      messages: [
        { at: "2026-01-01T00:00:00.000Z", id: "1", text: "hello Ada" },
      ],
      title: "a",
    },
    {
      id: "b",
      messages: [
        { at: "2026-01-02T00:00:00.000Z", id: "2", text: "hello Ada" },
      ],
      title: "b",
    },
  ]);
  expect(twice.map((c) => c.id)).toEqual(["a"]);
});

test("the status card shows his newest imported message once an export is in", () => {
  expect(newestAssistant("chatgpt")).toEqual({
    at: null,
    facts: [{ label: "Conversations", value: "0" }],
  });
  const to = importOf("chatgpt");
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, JSON.stringify(chatgptExport));
  expect(newestAssistant("chatgpt")).toEqual({
    at: new Date(1_772_000_100_000).toISOString(),
    facts: [{ label: "Conversations", value: "1" }],
  });
});
