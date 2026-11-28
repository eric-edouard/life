import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../core/hash";
import { ShapeReport } from "../core/shape-report";
import { incomingArchived } from "./archived";
import { openWhatsapp, readWhatsapp } from "./whatsapp";
import {
  chatNameOf,
  copyWhatsappExport,
  importWhatsappExports,
  isWhatsappExport,
  parseWhatsappExport,
  readWhatsappExport,
} from "./whatsapp-export";

// Made-up chat exports in the shapes both phones write, and the copies and archive rows they become.

const ME = "Sam Rivera";
const OTHER = "Jane Doe";
const ownerNames = [ME];
/** A wall clock as an instant, with no zone to read: the day he was in is the one the export says. */
const atWall = (day: string, hm: string) => `${day}T${hm}:00.000Z`;
const read = (text: string, name?: string) =>
  parseWhatsappExport(text, { atWall, name, ownerNames });
const tmp = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));

const IOS_CHAT = `[10/03/2025, 09:05:03] ${ME}: morning
[10/03/2025, 09:06:00] ${OTHER}: the boiler is broken
still dripping
[10/03/2025, 09:07:10] ${OTHER}: <attached: 00000001-PHOTO-2025-03-10.jpg>
[10/03/2025, 09:08:00] Messages and calls are end-to-end encrypted.
[10/03/2025, 21:05:00] ${OTHER}: image omitted
`;

test("an iPhone export reads: both sides, a continuation, a system line and a placeholder", () => {
  const chat = read(IOS_CHAT, OTHER);
  expect(chat.chatName).toBe(OTHER);
  expect(chat.owner).toBe(ME);
  expect(chat.messages.map((m) => [m.at, m.fromMe, m.sender, m.text])).toEqual([
    ["2025-03-10T09:05:03.000Z", true, "me", "morning"],
    [
      "2025-03-10T09:06:00.000Z",
      false,
      OTHER,
      "the boiler is broken\nstill dripping",
    ],
    [
      "2025-03-10T09:07:10.000Z",
      false,
      OTHER,
      "<attached: 00000001-PHOTO-2025-03-10.jpg>",
    ],
    ["2025-03-10T21:05:00.000Z", false, OTHER, "image omitted"],
  ]);
});

test("an Android export reads: 12h clock, dots, a two-digit year, a system line skipped", () => {
  const chat = read(`25.03.25, 8:17 pm - ${OTHER}: <Media omitted>
25.03.25, 08:18 - ${ME}: on my way
25.03.25, 08:19 - ${OTHER} changed the subject to "Boiler"
`);
  expect(chat.messages.map((m) => [m.at, m.fromMe, m.text])).toEqual([
    ["2025-03-25T20:17:00.000Z", false, "<Media omitted>"],
    ["2025-03-25T08:18:00.000Z", true, "on my way"],
  ]);
});

test("the day and month order comes from the data, else day first", () => {
  expect(read(`03/13/2025, 09:00 - ${OTHER}: hello\n`).messages[0]?.at).toBe(
    "2025-03-13T09:00:00.000Z"
  );
  expect(read(`13/03/2025, 09:00 - ${OTHER}: hello\n`).messages[0]?.at).toBe(
    "2025-03-13T09:00:00.000Z"
  );
  expect(read(`05/03/2025, 09:00 - ${OTHER}: hello\n`).messages[0]?.at).toBe(
    "2025-03-05T09:00:00.000Z"
  );
});

test("the other person is the file's name, else the one other sender", () => {
  expect(read(IOS_CHAT, OTHER).chatName).toBe(OTHER);
  expect(read(IOS_CHAT).chatName).toBe(OTHER);
  expect(chatNameOf(`/tmp/WhatsApp Chat with ${OTHER}.txt`)).toBe(OTHER);
  expect(chatNameOf(`/tmp/WhatsApp Chat - ${OTHER}`)).toBe(OTHER);
  expect(chatNameOf("/tmp/_chat.txt")).toBeUndefined();
});

test("a copy is named by its own bytes and the chat's name, and the same bytes are kept once", () => {
  const dir = tmp("wa-copies-");
  const file = join(dir, `WhatsApp Chat with ${OTHER}.txt`);
  writeFileSync(file, IOS_CHAT);
  const copies = join(dir, "imports", "whatsapp");
  const first = copyWhatsappExport(file, copies);
  expect(first.path).toBe(
    join(copies, `${digest("sha256", IOS_CHAT, 12)} ${OTHER}.txt`)
  );
  expect(first.isNew).toBe(true);
  expect(readdirSync(copies)).toEqual([`${first.hex} ${OTHER}.txt`]);
  const again = copyWhatsappExport(file, copies);
  expect(again).toEqual({ ...first, isNew: false });
  expect(readdirSync(copies)).toHaveLength(1);
});

test("an imported export reads as messages of its chat, never as arrivals", () => {
  const dir = tmp("wa-import-");
  const copies = join(dir, "imports", "whatsapp");
  const file = join(dir, `WhatsApp Chat with ${OTHER}.txt`);
  writeFileSync(file, IOS_CHAT);
  const copy = copyWhatsappExport(file, copies);
  const archive = join(dir, "archive");
  const tried = new Set<string>();
  const first = importWhatsappExports(tried, {
    archive,
    atWall,
    copies,
    ownerNames,
  });
  expect(first).toEqual({ added: 4, copies: 1, failed: [] });
  expect(tried.has(copy.hex)).toBe(true);

  const messages = readWhatsapp(new Date(0), archive, join(dir, "wa"));
  expect(messages.map((m) => [m.chat, m.fromMe, m.text])).toEqual([
    [`export:${copy.hex}`, true, "morning"],
    [`export:${copy.hex}`, false, "the boiler is broken\nstill dripping"],
    [`export:${copy.hex}`, false, "<attached: 00000001-PHOTO-2025-03-10.jpg>"],
    [`export:${copy.hex}`, false, "image omitted"],
  ]);
  expect(messages[0]?.chatName).toBe(OTHER);
  expect(incomingArchived("whatsapp", "id", undefined, archive).rows).toEqual(
    []
  );

  // A second pass, as a new process reads it: the rows are in, so nothing is added again.
  const second = importWhatsappExports(new Set<string>(), {
    archive,
    atWall,
    copies,
    ownerNames,
  });
  expect(second).toEqual({ added: 0, copies: 1, failed: [] });
  expect(readWhatsapp(new Date(0), archive, join(dir, "wa"))).toHaveLength(4);
});

test("only messages before the archive's earliest copied message are written", () => {
  const dir = tmp("wa-cut-");
  const copies = join(dir, "imports", "whatsapp");
  const file = join(dir, "chat.txt");
  writeFileSync(file, IOS_CHAT);
  copyWhatsappExport(file, copies);
  const archive = join(dir, "archive");
  const db = openWhatsapp(archive);
  db.run(
    "insert into messages values ('S9', '120@g.us', 'Team', '+6600000001', 'An', 0, '2025-03-10T09:06:30.000Z', 0, 'live', '', '2025-03-10T09:07:00.000Z')"
  );
  db.close();

  expect(
    importWhatsappExports(new Set<string>(), {
      archive,
      atWall,
      copies,
      ownerNames,
    }).added
  ).toBe(2);
  expect(
    readWhatsapp(new Date(0), archive, join(dir, "wa")).map((m) => m.text)
  ).toEqual(["morning", "the boiler is broken\nstill dripping", "live"]);
});

test("a file of no known shape is a shape report, and no copy of it is kept", () => {
  const garbage = "hello there\nthis is not a chat\n";
  expect(() => read(garbage)).toThrow(ShapeReport);
  try {
    read(garbage);
  } catch (error) {
    expect((error as ShapeReport).fields).toEqual({
      counts: { lines: 2 },
      files: [],
      format: "whatsapp-txt",
      keys: [],
    });
  }
  const dir = tmp("wa-garbage-");
  const copies = join(dir, "imports", "whatsapp");
  mkdirSync(copies, { recursive: true });
  const hex = digest("sha256", garbage, 12);
  writeFileSync(join(copies, `${hex}.txt`), garbage);
  const tried = new Set<string>();
  const done = importWhatsappExports(tried, {
    archive: join(dir, "archive"),
    atWall,
    copies,
    ownerNames,
  });
  expect(done.added).toBe(0);
  expect(done.failed).toHaveLength(1);
  expect(done.failed[0]).toBeInstanceOf(ShapeReport);
  expect(tried.has(hex)).toBe(true);
});

test("a .txt or a folder holding its chat text is a WhatsApp export, and nothing else is", () => {
  const dir = tmp("wa-is-");
  const folder = join(dir, "WhatsApp Chat with Jane Doe");
  mkdirSync(folder);
  writeFileSync(join(folder, "_chat.txt"), IOS_CHAT);
  expect(isWhatsappExport(folder)).toBe(true);
  expect(isWhatsappExport(join(folder, "_chat.txt"))).toBe(true);
  expect(isWhatsappExport(join(dir, "conversations.json"))).toBe(false);
  expect(isWhatsappExport(join(dir, "nothing-here"))).toBe(false);
  expect(
    readWhatsappExport(folder, { atWall, ownerNames }).messages
  ).toHaveLength(4);
});
