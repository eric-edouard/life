import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  conversationsOf,
  exportsDir,
  FORMATS,
  formatOf,
  hasExportCopy,
  kept,
  newestAssistant,
  pruned,
  readAssistant,
  readImportedConversation,
} from "./assistants";
import { claudeExport } from "./store-fixtures";

// Made-up exports in the published shapes: claude.ai's chat_messages, ChatGPT's mapping tree.

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
  // An empty `text` falls back to the content blocks; the assistant's turns are read too, as not his.
  expect(ada?.messages.map((m) => [m.fromMe, m.text])).toEqual([
    [true, "My sister Ada moves to Lyon in May."],
    [false, "That sounds like a big change."],
    [true, "Help me plan her farewell dinner."],
  ]);
  expect(ada?.messages.filter((m) => m.fromMe).map((m) => m.text)).toEqual([
    "My sister Ada moves to Lyon in May.",
    "Help me plan her farewell dinner.",
  ]);
  // The edited turn he left (u2a) is another branch; his hidden custom instructions are not a message.
  expect(
    FORMATS.chatgpt
      .parse(chatgptExport)[0]
      ?.messages.filter((m) => m.fromMe)
      .map((m) => m.text)
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
        {
          at: "2026-01-01T00:00:00.000Z",
          fromMe: true,
          id: "1",
          text: "hello Ada",
        },
      ],
      title: "a",
      updatedAt: "",
    },
    {
      id: "b",
      messages: [
        {
          at: "2026-01-02T00:00:00.000Z",
          fromMe: true,
          id: "2",
          text: "hello Ada",
        },
      ],
      title: "b",
      updatedAt: "",
    },
  ]);
  expect(twice.map((c) => [c.id, c.messages.length])).toEqual([["a", 1]]);
});

const putCopy = (source: "chatgpt" | "claude", name: string, json: unknown) => {
  mkdirSync(exportsDir(source), { recursive: true });
  writeFileSync(join(exportsDir(source), name), JSON.stringify(json));
};

test("the status card shows his newest imported message once an export is in", () => {
  rmSync(exportsDir("chatgpt"), { force: true, recursive: true });
  expect(newestAssistant("chatgpt")).toEqual({
    at: null,
    facts: [{ label: "Conversations", value: "0" }],
  });
  putCopy("chatgpt", "conversations.json", chatgptExport);
  expect(newestAssistant("chatgpt")).toEqual({
    at: new Date(1_772_000_100_000).toISOString(),
    facts: [{ label: "Conversations", value: "1" }],
  });
});

// A made-up claude.ai conversation with an update time, and its messages as (id, who, text).
const claudeChat = (
  uuid: string,
  updated: string,
  ...turns: [string, "assistant" | "human", string][]
) => ({
  chat_messages: turns.map(([id, sender, text], i) => ({
    created_at: `2026-03-02T09:0${i}:00.000Z`,
    sender,
    text,
    uuid: id,
  })),
  name: `Chat ${uuid}`,
  updated_at: updated,
  uuid,
});

test("export copies read as one: a conversation at its latest version, the rest where its oldest copy had it", () => {
  rmSync(exportsDir("claude"), { force: true, recursive: true });
  const old = [
    claudeChat("a", "2026-03-02T10:00:00.000Z", [
      "a1",
      "human",
      "Ada moves in May.",
    ]),
    claudeChat("gone", "2026-03-02T10:00:00.000Z", [
      "g1",
      "human",
      "I deleted this one.",
    ]),
    claudeChat("b", "2026-03-02T10:00:00.000Z", [
      "b1",
      "human",
      "Dinner with Bo.",
    ]),
  ];
  putCopy("claude", "conversations.json", old);
  const alone = readAssistant("claude")(new Date(0));
  const newer = [
    claudeChat("new", "2026-04-01T10:00:00.000Z", [
      "n1",
      "human",
      "A new plan.",
    ]),
    claudeChat(
      "a",
      "2026-04-02T10:00:00.000Z",
      ["a1", "human", "Ada moves in May."],
      ["a2", "human", "She moved in June."]
    ),
    claudeChat("b", "2026-03-01T10:00:00.000Z", [
      "b1",
      "human",
      "An older Bo.",
    ]),
  ];
  putCopy("claude", "conversations.0123456789ab.json", newer);
  // `gone` is absent from the newer copy and still read; `b` stays at its older, later-updated version.
  expect(
    conversationsOf("claude").map((c) => [c.id, c.messages.length])
  ).toEqual([
    ["a", 2],
    ["gone", 1],
    ["b", 1],
    ["new", 1],
  ]);
  expect(conversationsOf("claude")[2]?.messages[0]?.text).toBe(
    "Dinner with Bo."
  );
  expect(readAssistant("claude")(new Date(0))).toHaveLength(alone.length + 2);
});

test("a conversation comes back whole, the assistant's turns too, from the copy holding its latest version", () => {
  rmSync(exportsDir("claude"), { force: true, recursive: true });
  putCopy("claude", "conversations.json", [
    claudeChat(
      "c",
      "2026-03-02T10:00:00.000Z",
      ["c1", "human", "```\nls\n```"],
      ["c2", "assistant", "Here is the listing."]
    ),
  ]);
  // All code: pruned out of memory, still fetchable by its id.
  expect(conversationsOf("claude")).toEqual([]);
  expect(
    readImportedConversation("claude:c")?.messages.map((m) => [
      m.fromMe,
      m.text,
    ])
  ).toEqual([
    [true, "```\nls\n```"],
    [false, "Here is the listing."],
  ]);
  expect(readImportedConversation("claude:zz")).toBeUndefined();
  expect(readImportedConversation("chatgpt:c")).toBeUndefined();
});

test("with one copy the conversations read exactly as the export pruned", () => {
  rmSync(exportsDir("claude"), { force: true, recursive: true });
  // The same words in two conversations: the first keeps them, the second drops them.
  const json = [
    claudeChat(
      "a",
      "2026-03-02T10:00:00.000Z",
      ["a1", "human", "Ada moves in May."],
      ["a2", "assistant", "Noted."]
    ),
    claudeChat(
      "b",
      "2026-03-03T10:00:00.000Z",
      ["b1", "human", "Ada moves in May."],
      ["b2", "human", "Then dinner."]
    ),
  ];
  putCopy("claude", "conversations.json", json);
  const alone = pruned(
    FORMATS.claude
      .parse(json)
      .map((c) => ({ ...c, messages: c.messages.filter((m) => m.fromMe) }))
  );
  expect(conversationsOf("claude")).toEqual(alone);
  expect(alone.map((c) => c.messages.map((m) => m.id))).toEqual([
    ["a1"],
    ["b2"],
  ]);
});

test("a file with no name in an export reads, and whether a copy is kept never parses one", () => {
  const chat = claudeChat("n1", "2026-03-02T10:00:00.000Z", [
    "m1",
    "human",
    "My notes from the trip",
  ]);
  const message = {
    ...chat.chat_messages[0],
    files: [{ file_name: null }, { file_name: "plan.pdf" }],
  };
  putCopy("claude", "conversations.json", [
    { ...chat, chat_messages: [message] },
  ]);
  expect(conversationsOf("claude")[0]?.messages[0]?.tags).toEqual([
    "[file plan.pdf]",
  ]);
  // A copy that does not parse is still found by its file: the source reads it, and fails, inside the night's guard.
  putCopy("claude", "conversations.json", "not an export");
  expect(hasExportCopy("claude")).toBe(true);
  rmSync(exportsDir("claude"), { force: true, recursive: true });
});
