import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { SourceEvent } from "../schema";
import { DATA } from "../truth";
import type { Newest } from ".";

// His conversations with AI assistants, from the one-time exports of claude.ai and ChatGPT (~/Life/docs/
// claude-import-scope-2026-10-21.md): his own messages only, pruned by code. An export is copied once to
// `imports/<source>/conversations.json` in his data. Every pruned message is searched; only the conversations the import
// step kept as about his life become memory (the `not-kept` rule, units.ts).

type Assistant = "chatgpt" | "claude";

/** A conversation as both exports reduce to: his messages, in order. */
export interface Conversation {
  id: string;
  messages: { at: string; id: string; text: string }[];
  title: string;
}

const iso = (s: number | string) =>
  new Date(typeof s === "number" ? s * 1000 : s).toISOString();

// The exports are undocumented and change: only the fields read here are checked, the rest pass.
const ClaudeExport = z.array(
  z.looseObject({
    chat_messages: z.array(
      z.looseObject({
        content: z
          .array(
            z.looseObject({ text: z.string().nullish(), type: z.string() })
          )
          .nullish(),
        created_at: z.string(),
        sender: z.string(),
        text: z.string().nullish(),
        uuid: z.string(),
      })
    ),
    name: z.string().nullish(),
    uuid: z.string(),
  })
);

/** claude.ai's `conversations.json`: an array of conversations, each its `chat_messages` (`sender` human or assistant). */
function parseClaude(json: unknown): Conversation[] {
  return ClaudeExport.parse(json).map((c) => ({
    id: c.uuid,
    messages: c.chat_messages
      .filter((m) => m.sender === "human")
      .map((m) => ({
        at: iso(m.created_at),
        id: m.uuid,
        // Newer exports carry the text in `content` blocks too; `text` is the whole message.
        text: (
          m.text ||
          (m.content ?? [])
            .flatMap((b) => (b.type === "text" && b.text ? [b.text] : []))
            .join("\n")
        ).trim(),
      })),
    title: c.name || "(untitled)",
  }));
}

const Node = z.looseObject({
  message: z
    .looseObject({
      author: z.looseObject({ role: z.string() }),
      content: z.looseObject({
        content_type: z.string(),
        parts: z.array(z.unknown()).nullish(),
      }),
      create_time: z.number().nullish(),
      id: z.string(),
      metadata: z
        .looseObject({
          is_visually_hidden_from_conversation: z.boolean().nullish(),
        })
        .nullish(),
    })
    .nullish(),
  parent: z.string().nullish(),
});
const ChatgptExport = z.array(
  z.looseObject({
    conversation_id: z.string().nullish(),
    create_time: z.number(),
    current_node: z.string().nullish(),
    id: z.string().nullish(),
    mapping: z.record(z.string(), Node),
    title: z.string().nullish(),
  })
);

/** A ChatGPT message part's words: a string, or what voice mode heard him say (`audio_transcription`); else none. */
const partText = (p: unknown) =>
  typeof p === "string"
    ? p
    : (z
        .object({
          content_type: z.literal("audio_transcription"),
          text: z.string(),
        })
        .safeParse(p).data?.text ?? "");

/**
 * ChatGPT's `conversations.json`: each conversation a tree of messages (`mapping`); the one he saw is the branch from
 * `current_node` back to the root (edited and regenerated turns are other branches). His are `author.role` user; a
 * hidden one is his custom instructions, not a message.
 */
function parseChatgpt(json: unknown): Conversation[] {
  return ChatgptExport.parse(json).map((c) => {
    const branch: z.infer<typeof Node>[] = [];
    for (
      let node = c.current_node ? c.mapping[c.current_node] : undefined;
      node;
      node = node.parent ? c.mapping[node.parent] : undefined
    ) {
      branch.unshift(node);
    }
    return {
      id: c.conversation_id ?? c.id ?? String(c.create_time),
      messages: branch.flatMap(({ message: m }) =>
        m &&
        m.author.role === "user" &&
        !m.metadata?.is_visually_hidden_from_conversation &&
        ["multimodal_text", "text"].includes(m.content.content_type)
          ? [
              {
                at: iso(m.create_time ?? c.create_time),
                id: m.id,
                text: (m.content.parts ?? [])
                  .map(partText)
                  .filter(Boolean)
                  .join("\n")
                  .trim(),
              },
            ]
          : []
      ),
      title: c.title || "(untitled)",
    };
  });
}

/** Each export's reader, and how its file is told apart (both are named `conversations.json`). */
export const FORMATS: Record<
  Assistant,
  {
    label: string;
    parse: (json: unknown) => Conversation[];
    test: (c: Record<string, unknown>) => boolean;
  }
> = {
  chatgpt: {
    label: "ChatGPT",
    parse: parseChatgpt,
    test: (c) => "mapping" in c,
  },
  claude: {
    label: "Claude",
    parse: parseClaude,
    test: (c) => "chat_messages" in c,
  },
};

/** Which export a parsed `conversations.json` is, from its first conversation. */
export const formatOf = (json: unknown) =>
  (Object.keys(FORMATS) as Assistant[]).find((a) => {
    const first = Array.isArray(json) ? json[0] : undefined;
    return first && typeof first === "object" && FORMATS[a].test(first);
  });

const FENCE =
  /```|^(\+\+\+|---|@@) |^diff --git|Traceback \(most recent call last\)|^\s+at .+:\d+:\d+\)?$/m;
const STRUCTURED = /^\s*(#{1,6} |[-*] |\d+\. |\|)/gm;
const TAG_LED = /^\s*<[a-z][\w-]*>/;
const BRIEF = /^Background \(from the session/;

/**
 * Whether a message of his is kept (the scope's measured rules): no code, diffs, stack traces or logs; nothing over
 * 6,000 characters, nor over 2,000 that is a pasted document (5 or more headings, list items or table rows); no
 * tag-led line (a tool's notice) and no brief an agent wrote.
 */
export function kept(text: string) {
  if (
    !text ||
    text.length > 6000 ||
    FENCE.test(text) ||
    TAG_LED.test(text) ||
    BRIEF.test(text)
  ) {
    return false;
  }
  return text.length <= 2000 || (text.match(STRUCTURED)?.length ?? 0) < 5;
}

/** An export's conversations, his kept messages only (an identical message seen before dropped: a resend, a fork). */
export function pruned(all: Conversation[]) {
  const seen = new Set<string>();
  return all.flatMap((c) => {
    const messages = c.messages.filter((m) => {
      const fresh = kept(m.text) && !seen.has(m.text);
      seen.add(m.text);
      return fresh;
    });
    return messages.length > 0 ? [{ ...c, messages }] : [];
  });
}

/** An export as read: how many conversations it holds, and its conversations pruned. */
export function parsedExport(source: Assistant, json: unknown) {
  const all = FORMATS[source].parse(json);
  return { all: all.length, conversations: pruned(all) };
}

/** Where an assistant's export is kept in his data. */
export const importOf = (source: Assistant, data = DATA) =>
  join(data, "imports", source, "conversations.json");

const memo = new Map<
  string,
  { conversations: Conversation[]; mtime: number }
>();
/**
 * An imported export's pruned conversations, none before it is imported. Read once per process (and again only when
 * the file changes): a unit's `builtFor` reads its source again.
 */
export function conversationsOf(source: Assistant, path = importOf(source)) {
  if (!existsSync(path)) {
    return [];
  }
  const { mtimeMs } = statSync(path);
  if (memo.get(path)?.mtime !== mtimeMs) {
    const { conversations } = parsedExport(
      source,
      JSON.parse(readFileSync(path, "utf8"))
    );
    memo.set(path, { conversations, mtime: mtimeMs });
  }
  return memo.get(path)?.conversations ?? [];
}

/**
 * His pruned messages since `since`, as events, oldest first: a conversation is a chat (its title says it was with an
 * assistant, so the memory steps read it as such), cut into a unit per local day.
 */
export const readAssistant =
  (source: Assistant) =>
  (since: Date, path = importOf(source)): SourceEvent[] =>
    conversationsOf(source, path)
      .flatMap((c) =>
        c.messages.map(
          (m): SourceEvent => ({
            at: m.at,
            chat: `${source}:${c.id}`,
            chatName: `Chat with ${FORMATS[source].label}: ${c.title}`,
            fromMe: true,
            id: `${source}:${c.id}/${m.id}`,
            sender: "me",
            source,
            text: m.text,
          })
        )
      )
      .filter((e) => e.at >= since.toISOString())
      .sort((a, b) => a.at.localeCompare(b.at));

/** The status page's card: when his newest imported message was, and how many conversations were imported. */
export function newestAssistant(source: Assistant): Newest {
  const conversations = conversationsOf(source);
  return {
    at:
      conversations
        .flatMap((c) => c.messages.map((m) => m.at))
        .sort()
        .at(-1) ?? null,
    facts: [{ label: "Conversations", value: String(conversations.length) }],
  };
}
