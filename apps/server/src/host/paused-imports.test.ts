import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openWhatsapp } from "../sources/whatsapp";
import { pausedImportsNow } from "./paused-imports";

// The export copies Life cannot read yet, on made-up copies and a made-up archive: the read is pure, cached an hour.

const made = mkdtempSync(join(tmpdir(), "life-paused-"));
afterAll(() => rmSync(made, { force: true, recursive: true }));

/** A made-up data folder with its WhatsApp copies and its archive. */
const dirsOf = (name: string) => {
  const data = join(made, name);
  const archive = join(data, "archive");
  mkdirSync(join(data, "imports", "whatsapp"), { recursive: true });
  mkdirSync(archive, { recursive: true });
  return { archive, data };
};

/** A digest's hex. */
const DIGEST = /^[0-9a-f]{12}$/;

const copyOf = (data: string, file: string, text: string) =>
  writeFileSync(join(data, "imports", "whatsapp", file), text);

test("a WhatsApp copy whose parse throws a shape report is paused, with its digest and no words", async () => {
  const { archive, data } = dirsOf("whatsapp");
  copyOf(data, "aaaaaaaaaaaa.txt", "not a chat export, only a line\n");
  const paused = await pausedImportsNow({ archive, data });
  expect(paused).toHaveLength(1);
  expect(paused[0]).toMatchObject({
    report: { format: "whatsapp-txt" },
    source: "whatsapp",
  });
  expect(paused[0]?.digest).toMatch(DIGEST);
  expect(JSON.stringify(paused[0]?.report)).not.toContain("not a chat");
});

test("a copy the archive already holds export rows for is never paused, whatever its parse does", async () => {
  const { archive, data } = dirsOf("archived");
  copyOf(data, "bbbbbbbbbbbb.txt", "not a chat export, only a line\n");
  const db = openWhatsapp(archive);
  try {
    db.run(
      "insert into messages (id, chat, chatName, sender, senderName, fromMe, at, type, text, media, seenAt) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "export:bbbbbbbbbbbb/1/1",
        "export:bbbbbbbbbbbb",
        "A chat",
        "me",
        "me",
        1,
        "2026-01-01T00:00:00.000Z",
        0,
        "a message",
        "",
        "2026-01-01T00:00:00.000Z",
      ]
    );
  } finally {
    db.close();
  }
  expect(await pausedImportsNow({ archive, data })).toEqual([]);
});

test("a copy that parses, and an assistant's copy that parses, are not paused", async () => {
  const { archive, data } = dirsOf("readable");
  copyOf(
    data,
    "cccccccccccc.txt",
    "[01/02/2026, 10:00:00] Sam Rivera: morning\n"
  );
  mkdirSync(join(data, "imports", "claude"), { recursive: true });
  writeFileSync(
    join(data, "imports", "claude", "conversations.json"),
    JSON.stringify([{ chat_messages: [], name: "A talk", uuid: "u1" }])
  );
  expect(await pausedImportsNow({ archive, data })).toEqual([]);
});

test("an assistant's export copy whose parse throws a shape report is paused, under its source", async () => {
  const { archive, data } = dirsOf("assistant");
  mkdirSync(join(data, "imports", "chatgpt"), { recursive: true });
  writeFileSync(
    join(data, "imports", "chatgpt", "conversations.json"),
    JSON.stringify({ not: "an export" })
  );
  const paused = await pausedImportsNow({ archive, data });
  expect(paused.map((p) => p.source)).toEqual(["chatgpt"]);
  expect(paused[0]?.report.format).toBe("assistant-export");
  expect(paused[0]?.report.keys).toEqual(["not"]);
});
