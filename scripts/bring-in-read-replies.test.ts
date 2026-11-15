import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "@life/server/src/core/clock";
import {
  READS,
  readReplyIndex,
  storeReply,
} from "@life/server/src/memory/exchange-reads";
import { eventKey, type SourceEvent } from "@life/server/src/records/source";
import { takenOf, twoWayChatsOf } from "./bring-in-read-replies";

const START = Date.parse("2026-10-01T12:00:00.000Z");
const msg = (ms: number, fromMe: boolean, chat = "+1"): SourceEvent => ({
  at: new Date(START + ms).toISOString(),
  chat,
  fromMe,
  id: `${chat}:${ms}`,
  sender: fromMe ? "me" : chat,
  source: "whatsapp",
  text: "hello",
});
const resolve = (s: string) => (s === "+1" || s === "+2" ? "person:ann" : null);
const START_AT = new Date(START).toISOString();
const talk = [
  msg(0, false),
  msg(1000, true),
  msg(30 * HOUR, false),
  msg(30 * HOUR + 1000, true),
];
// Only she ever wrote in this chat: not two-way.
const alone = [msg(0, false, "+2"), msg(1000, false, "+2")];
const chats = twoWayChatsOf([...talk, ...alone], resolve);
const kept = (messages: SourceEvent[], over: Record<string, unknown> = {}) => ({
  madeBy: {
    engine: "codex",
    model: "m",
    prompt: READS.connection.prompt,
    run: "2026-10-05T10-00-00.000Z",
  },
  messages: messages.map(eventKey),
  promptDigest: "a".repeat(16),
  reply: { exchanges: [] },
  starts: [0],
  ...over,
});

test("which pilot files are brought in: valid, of the current prompt, one two-way direct chat, an unread exchange; a second pass takes none", () => {
  const dir = mkdtempSync(join(tmpdir(), "bring-"));
  const where = join(dir, "lines");
  try {
    const first = talk.slice(0, 2);
    const files = [
      kept(first),
      kept(first, {
        madeBy: {
          engine: "codex",
          model: "m",
          prompt: "memory-connection.v2",
          run: "r",
        },
      }),
      kept([...first, ...alone]),
      kept(alone),
      kept(talk.slice(0, 3)),
      { nope: true },
    ];
    const verdicts = (files_: unknown[]) =>
      files_.map((f) => takenOf(f, "connection", chats, readReplyIndex(where)));
    const first_ = verdicts(files);
    expect(first_.map((v) => (typeof v === "string" ? v : "taken"))).toEqual([
      "taken",
      "another prompt",
      "not one two-way direct chat's",
      "not one two-way direct chat's",
      "no unread exchange",
      "invalid",
    ]);
    // The brought-in line is the file's, with the instant of its run.
    const [line] = first_;
    expect(typeof line === "string" ? "" : line?.at).toBe(
      "2026-10-05T10:00:00.000Z"
    );
    if (line && typeof line !== "string") {
      storeReply(line, START_AT, where);
    }
    expect(verdicts(files).filter((v) => typeof v !== "string")).toEqual([]);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});
