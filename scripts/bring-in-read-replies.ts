// `bun scripts/bring-in-read-replies.ts`: brings the pilot's replies into memory once (docs/operations.md, "Exchange
// reads"): each kept file of the label `openrouter` (`memory-pilot.ts`'s old per-key files, left where they are)
// made by a read's current prompt, whose messages are all one living one-to-one chat's and that holds an exchange no
// stored reply reads yet, becomes a line of memory/read-replies/. Under the memory lock. Prints counts, never a word.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readJson } from "@life/server/src/core/files";
import { directChats, readWithPeople } from "@life/server/src/memory/closeness";
import {
  READS,
  readReplyIndex,
  replyOf,
  storeReply,
} from "@life/server/src/memory/exchange-reads";
import { exchangesOf, isLiving } from "@life/server/src/memory/exchanges";
import { runAt } from "@life/server/src/memory/ledger";
import { locked } from "@life/server/src/memory/memory-lock";
import { readPeople } from "@life/server/src/memory/who";
import {
  READ_NAMES,
  type ReadName,
  ReadReply,
} from "@life/server/src/records/read-reply";
import {
  chatGroups,
  eventKey,
  type SourceEvent,
} from "@life/server/src/records/source";
import { KEPT } from "./memory-pilot";

/** A pilot file: a stored line without what the pilot did not keep (when, which read, the schema). */
const Kept = ReadReply.omit({ at: true, read: true, schemaVersion: true });

/** The messages of his living one-to-one chats: the chat each is in, and each exchange by its first message's key. */
export function livingChatsOf(
  events: SourceEvent[],
  resolve: (s: string) => string | null
) {
  const chatOf = new Map<string, string>();
  const todays = new Map<string, SourceEvent[]>();
  for (const [ref, messages] of directChats(events, resolve)) {
    if (ref.startsWith("person:")) {
      for (const [chat, list] of chatGroups(messages)) {
        if (isLiving(list)) {
          for (const e of list) {
            chatOf.set(eventKey(e), chat);
          }
          for (const x of exchangesOf(list)) {
            todays.set(eventKey(x[0] as SourceEvent), x);
          }
        }
      }
    }
  }
  return { chatOf, todays };
}

/**
 * What becomes of a pilot file: the stored line to append, or why it is left out. Taken when it is valid, made by
 * the read's current prompt, all of one living chat, and holds an exchange as it is today that `read` has no stored
 * reply for (`replyOf`); a second pass finds that reply and takes nothing.
 */
export function takenOf(
  raw: unknown,
  read: ReadName,
  chats: ReturnType<typeof livingChatsOf>,
  index: ReturnType<typeof readReplyIndex>
) {
  const kept = Kept.safeParse(raw);
  if (!kept.success) {
    return "invalid";
  }
  const { madeBy, messages, starts } = kept.data;
  if (madeBy.prompt !== READS[read].prompt) {
    return "another prompt";
  }
  const chat = chats.chatOf.get(messages[0] as string);
  if (!(chat && messages.every((k) => chats.chatOf.get(k) === chat))) {
    return "not one living direct chat's";
  }
  const isUnread = starts.some((start, i) => {
    const keys = messages.slice(start, starts[i + 1]);
    const today = chats.todays.get(keys[0] ?? "");
    return (
      today?.length === keys.length &&
      today.every((e, j) => eventKey(e) === keys[j]) &&
      !replyOf(today, read, index)
    );
  });
  if (!isUnread) {
    return "no unread exchange";
  }
  const line = ReadReply.safeParse({
    ...kept.data,
    at: runAt(madeBy.run),
    read,
    schemaVersion: 1,
  });
  return line.success ? line.data : "invalid";
}

if (import.meta.main) {
  const { events, failed } = await readWithPeople(new Date(0));
  if (failed.length > 0) {
    throw new Error(`not read: ${failed.join(", ")}`);
  }
  const chats = livingChatsOf(events, (await readPeople()).resolve);
  const counts = new Map<string, number>();
  const count = (what: string) => counts.set(what, (counts.get(what) ?? 0) + 1);
  const done = await locked(() => {
    for (const read of READ_NAMES) {
      const dir = join(KEPT, read, "openrouter");
      for (const file of existsSync(dir) ? readdirSync(dir) : []) {
        const taken = takenOf(
          readJson(join(dir, file)),
          read,
          chats,
          readReplyIndex()
        );
        count("seen");
        count(typeof taken === "string" ? taken : "appended");
        if (typeof taken !== "string") {
          storeReply(taken);
        }
      }
    }
    return Promise.resolve();
  });
  process.exitCode = done ? 0 : 1;
  console.table([Object.fromEntries(counts)]);
}
