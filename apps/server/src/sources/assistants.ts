import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { OWNER_DATA_DIR } from "../core/paths";
import type { SourceEvent } from "../records/source";
import { isWithin, type Newest } from "./contract";

// His conversations with AI assistants, from the exports of claude.ai and ChatGPT (~/Life/docs/
// claude-import-scope-2026-10-21.md). Each export is kept as it came in `imports/<source>/` in his data (an export
// copy, never replaced or merged); a conversation reads from the copy holding its latest version. Memory takes his own
// messages only, pruned by code: every pruned message is searched, and only the conversations the import step kept as
// about his life become memory (the `not-kept` rule, units.ts). `fetch` gives one back whole, the assistant's turns too.

type Assistant = "chatgpt" | "claude";

/** A turn of a conversation as both exports reduce to: who wrote it, its words, and the files it carried as tags. */
export interface Turn {
  at: string;
  fromMe: boolean;
  id: string;
  tags?: string[];
  text: string;
}

/** A conversation as both exports reduce to: its turns in order, and when the export says it was last updated. */
export interface Conversation {
  id: string;
  messages: Turn[];
  title: string;
  updatedAt: string;
}

const iso = (s: number | string) =>
  new Date(typeof s === "number" ? s * 1000 : s).toISOString();

/** When a conversation was last updated: the export's word, or its newest turn if that is later. */
const updatedOf = (stated: number | string | null | undefined, turns: Turn[]) =>
  [...(stated ? [iso(stated)] : []), ...turns.map((m) => m.at)].sort().at(-1) ??
  "";

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
        files: z.array(z.looseObject({ file_name: z.string() })).nullish(),
        sender: z.string(),
        text: z.string().nullish(),
        uuid: z.string(),
      })
    ),
    name: z.string().nullish(),
    updated_at: z.string().nullish(),
    uuid: z.string(),
  })
);

/** claude.ai's `conversations.json`: an array of conversations, each its `chat_messages` (`sender` human or assistant). */
function parseClaude(json: unknown): Conversation[] {
  return ClaudeExport.parse(json).map((c) => {
    const messages = c.chat_messages.map(
      (m): Turn => ({
        at: iso(m.created_at),
        fromMe: m.sender === "human",
        id: m.uuid,
        ...(m.files?.length
          ? { tags: m.files.map((f) => `[file ${f.file_name}]`) }
          : {}),
        // Newer exports carry the text in `content` blocks too; `text` is the whole message.
        text: (
          m.text ||
          (m.content ?? [])
            .flatMap((b) => (b.type === "text" && b.text ? [b.text] : []))
            .join("\n")
        ).trim(),
      })
    );
    return {
      id: c.uuid,
      messages,
      title: c.name || "(untitled)",
      updatedAt: updatedOf(c.updated_at, messages),
    };
  });
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
    update_time: z.number().nullish(),
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

/** A ChatGPT message part that is a file, not words, as a tag. */
const partTag = (p: unknown) =>
  typeof p === "string" || partText(p)
    ? []
    : [
        z
          .object({ content_type: z.literal("image_asset_pointer") })
          .safeParse(p).success
          ? "[image]"
          : "[attachment]",
      ];

/**
 * ChatGPT's `conversations.json`: each conversation a tree of messages (`mapping`); the one he saw is the branch from
 * `current_node` back to the root (edited and regenerated turns are other branches). His are `author.role` user, the
 * assistant's `assistant`; a hidden one is his custom instructions, not a message.
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
    const messages = branch.flatMap(({ message: m }): Turn[] => {
      if (
        !(m && ["assistant", "user"].includes(m.author.role)) ||
        m.metadata?.is_visually_hidden_from_conversation ||
        !["multimodal_text", "text"].includes(m.content.content_type)
      ) {
        return [];
      }
      const parts = m.content.parts ?? [];
      const tags = parts.flatMap(partTag);
      return [
        {
          at: iso(m.create_time ?? c.create_time),
          fromMe: m.author.role === "user",
          id: m.id,
          ...(tags.length ? { tags } : {}),
          text: parts.map(partText).filter(Boolean).join("\n").trim(),
        },
      ];
    });
    return {
      id: c.conversation_id ?? c.id ?? String(c.create_time),
      messages,
      title: c.title || "(untitled)",
      updatedAt: updatedOf(c.update_time, messages),
    };
  });
}

/** Each export's reader, and how its conversations are told apart (both name their file `conversations`). */
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

/** Conversations with his kept messages only (an identical message seen before dropped: a resend, a fork). */
export function pruned(all: Conversation[]) {
  const seen = new Set<string>();
  return all.flatMap((c) => {
    const messages = c.messages.filter((m) => {
      const fresh = m.fromMe && kept(m.text) && !seen.has(m.text);
      if (m.fromMe) {
        seen.add(m.text);
      }
      return fresh;
    });
    return messages.length > 0 ? [{ ...c, messages }] : [];
  });
}

/** An export as read: its conversations with his messages only (the assistant's turns are not memory). */
export function parsedExport(source: Assistant, json: unknown) {
  return FORMATS[source]
    .parse(json)
    .map((c) => ({ ...c, messages: c.messages.filter((m) => m.fromMe) }));
}

/** Where an assistant's export copies are kept in his data. */
export const exportsDir = (source: Assistant, data = OWNER_DATA_DIR) =>
  join(data, "imports", source);

/** An export copy's file: `conversations.json`, or `conversations.<12 hex of its bytes>.json` for a later one. */
export const COPY = /^conversations(\.[0-9a-f]{12})?\.json$/;

interface Copy {
  conversations: Conversation[];
  path: string;
  updatedAt: string;
}

const memo = new Map<string, Copy & { mtime: number }>();
/** Oldest first by the newest update each copy holds, never by name: the one definition of copy order. */
const inCopyOrder = (copies: Copy[]) =>
  [...copies].sort(
    (a, b) =>
      a.updatedAt.localeCompare(b.updatedAt) || a.path.localeCompare(b.path)
  );

/**
 * The export copies kept for an assistant, in copy order, each with his messages and update times. Each is parsed once
 * per process (and again only when its file changes): a unit's `builtFor` reads its source again.
 */
export function exportCopiesOf(source: Assistant, dir = exportsDir(source)) {
  if (!existsSync(dir)) {
    return [];
  }
  return inCopyOrder(
    readdirSync(dir)
      .filter((f) => COPY.test(f))
      .map((f): Copy => {
        const path = join(dir, f);
        const { mtimeMs } = statSync(path);
        let hit = memo.get(path);
        if (hit?.mtime !== mtimeMs) {
          const conversations = parsedExport(
            source,
            JSON.parse(readFileSync(path, "utf8"))
          );
          hit = {
            conversations,
            mtime: mtimeMs,
            path,
            updatedAt:
              conversations
                .map((c) => c.updatedAt)
                .sort()
                .at(-1) ?? "",
          };
          memo.set(path, hit);
        }
        return hit;
      })
  );
}

/**
 * Each conversation once: its latest version (the export says it was updated last; a tie goes to the later copy) with
 * the path of the copy holding it, and its first version. Where it sits is where the oldest copy holding it has it,
 * new ones following in their copy's order, so one copy reads exactly as itself.
 */
export function latestVersions(copies: Copy[]) {
  const versions = new Map<
    string,
    { first: Conversation; latest: Conversation; path: string }
  >();
  for (const { conversations, path } of inCopyOrder(copies)) {
    for (const c of conversations) {
      const have = versions.get(c.id);
      if (!have || c.updatedAt >= have.latest.updatedAt) {
        versions.set(c.id, { first: have?.first ?? c, latest: c, path });
      }
    }
  }
  return versions;
}

/** The conversations as memory reads them: each at its latest version, pruned. */
export const conversationsOf = (source: Assistant, dir?: string) =>
  pruned(
    [...latestVersions(exportCopiesOf(source, dir)).values()].map(
      (v) => v.latest
    )
  );

let lastRead: {
  conversation: Conversation;
  key: string;
  mtime: number;
} | null = null;
/**
 * One conversation whole, every turn of its latest version (`<source>:<id>`, as search cites it), or none. Parsed on
 * demand from the copy holding it; the last one is kept, so paging through it does not read the copy again.
 */
export function readConversation(key: string, dir?: string) {
  const source = (Object.keys(FORMATS) as Assistant[]).find((a) =>
    key.startsWith(`${a}:`)
  );
  const found = source
    ? latestVersions(exportCopiesOf(source, dir)).get(
        key.slice(`${source}:`.length)
      )
    : undefined;
  if (!(source && found)) {
    return;
  }
  const { mtimeMs } = statSync(found.path);
  if (lastRead?.key !== found.path + key || lastRead.mtime !== mtimeMs) {
    const conversation = FORMATS[source]
      .parse(JSON.parse(readFileSync(found.path, "utf8")))
      .find((c) => c.id === found.latest.id);
    lastRead = conversation
      ? { conversation, key: found.path + key, mtime: mtimeMs }
      : null;
  }
  return lastRead?.conversation;
}

/**
 * His pruned messages since `since`, as events, oldest first: a conversation is a chat (its title says it was with an
 * assistant, so the memory steps read it as such), cut into a unit per local day.
 */
export const readAssistant =
  (source: Assistant) =>
  (since: Date, dir?: string, before?: Date): SourceEvent[] =>
    conversationsOf(source, dir)
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
      .filter(isWithin(since, before))
      .sort((a, b) => a.at.localeCompare(b.at));

/** The first imported message's timestamp, using the export's read-once cache. */
export const readEarliestAssistant = (source: Assistant) =>
  conversationsOf(source)
    .flatMap((c) => c.messages.map((m) => m.at))
    .sort()[0] ?? null;

/** The status snapshot's card: when his newest imported message was, and how many conversations were imported. */
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
