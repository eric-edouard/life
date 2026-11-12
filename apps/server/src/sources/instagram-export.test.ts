import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { incomingArchived } from "./archived";
import { NETWORKS, type Network, openBridged, readBridged } from "./bridged";
import {
  copyInstagramExport,
  decoded,
  isInstagramExport,
  readExportChats,
} from "./instagram-export";

const INSTAGRAM = NETWORKS.find((n) => n.name === "instagram") as Network;
const ME = "Sam Rivera";
const T = Date.parse("2025-03-10T09:00:00.000Z");
/** A string as Meta's export writes it: each UTF-8 byte as one character. */
const garbled = (s: string) => Buffer.from(s, "utf8").toString("latin1");
const said = (sender: string, ms: number, more: object) => ({
  sender_name: sender,
  timestamp_ms: ms,
  ...more,
});

/** A made-up export: `chats` by folder name, each a list of messages with the other person's name. */
function exportOf(
  chats: Record<string, { other: string; messages: object[] }>
) {
  const root = mkdtempSync(join(tmpdir(), "ig-export-"));
  for (const [name, c] of Object.entries(chats)) {
    const dir = join(root, "your_instagram_activity/messages/inbox", name);
    mkdirSync(join(dir, "photos"), { recursive: true });
    writeFileSync(
      join(dir, "message_1.json"),
      JSON.stringify({
        // Newest first, as the export writes them.
        messages: c.messages.toReversed(),
        participants: [{ name: garbled(c.other) }, { name: ME }],
        title: garbled(c.other),
      })
    );
  }
  return root;
}
const chatDir = (root: string, name: string) =>
  join(root, "your_instagram_activity/messages/inbox", name);
const dirs = () => ({
  archive: mkdtempSync(join(tmpdir(), "ig-archive-")),
  bridges: mkdtempSync(join(tmpdir(), "ig-bridges-")),
});

const ANA = [
  said("Ana LÃ³pez", T, { content: garbled("Café at 5? \u{1f600}") }),
  said(ME, T + 1000, { content: "Liked a message" }),
  said(ME, T + 2000, {}),
  said(ME, T + 3000, {
    content: "Sam Rivera sent an attachment.",
    share: { link: "https://example.com/reel/1" },
  }),
  said("Ana LÃ³pez", T + 4000, {
    call_duration: 60,
    content: "Ana LÃ³pez started a video chat",
  }),
  said("Ana LÃ³pez", T + 64_000, {
    call_duration: 0,
    content: "Video chat ended",
  }),
  said(ME, T + 70_000, {
    photos: [
      { uri: "your_instagram_activity/messages/inbox/ana_10001/photos/a.jpg" },
      { uri: "../../../outside/secret.jpg" },
      {
        uri: "your_instagram_activity/messages/inbox/ana_10001/photos/link.jpg",
      },
    ],
  }),
];
const BEN = [said("Ben Ito", T + 500, { content: "hello" })];

function anaAndBen() {
  const root = exportOf({
    ana_10001: { messages: ANA, other: "Ana López" },
    ben_10002: { messages: BEN, other: "Ben Ito" },
    // A folder with no id is no chat.
    notes: { messages: BEN, other: "Nobody" },
  });
  writeFileSync(join(chatDir(root, "ana_10001"), "photos/a.jpg"), "jpeg");
  // A link is not a file of the export, whatever it points at.
  const outside = join(root, "outside.jpg");
  writeFileSync(outside, "private");
  symlinkSync(outside, join(chatDir(root, "ana_10001"), "photos/link.jpg"));
  return root;
}

test("an export's chats are read as what each message is worth: words decoded, reactions and empty messages dropped, a share its link, a call a notice, files by their name in the chat's own folder", () => {
  expect(decoded(garbled("déjà \u{1f600}"))).toBe("déjà \u{1f600}");
  const root = anaAndBen();
  expect(isInstagramExport(root)).toBe(true);
  const chats = readExportChats(root);
  expect(chats.map((c) => [c.id, c.title])).toEqual([
    ["10001", "Ana López"],
    ["10002", "Ben Ito"],
  ]);
  const [ana] = chats;
  expect(ana?.messages.map((m) => [m.ms - T, m.isCall, m.text])).toEqual([
    [0, false, "Café at 5? \u{1f600}"],
    [3000, false, "https://example.com/reel/1"],
    [4000, true, "Ana López started a video chat"],
    [64_000, true, "Video chat ended"],
    [70_000, false, ""],
  ]);
  // The photo the folder holds has its place; a name from another path and a link have none.
  expect(
    ana?.messages.at(-1)?.files.map((f) => [f.name, f.mimeType, !!f.from])
  ).toEqual([
    ["a.jpg", "image/jpeg", true],
    ["secret.jpg", "image/jpeg", false],
    ["link.jpg", "image/jpeg", false],
  ]);
});

test("an export is copied once: a second import adds nothing, its rows are read before the cutover and are no arrival, its files cloned", () => {
  const { archive, bridges } = dirs();
  const root = anaAndBen();
  const now = Date.parse("2026-11-12T00:00:00.000Z");
  // Life's own copy began long after these messages: what a bridge backfills from before it is never read.
  const db = openBridged("instagram", archive);
  db.run("insert into cutover values ('2026-10-29T00:00:00.000Z')");
  db.close();
  const dry = copyInstagramExport(root, { archive, bridges, dry: true, now });
  expect(dry).toMatchObject({
    added: 6,
    chats: 2,
    duplicates: 0,
    files: { kept: 1, missing: 2 },
    photos: 1,
  });
  // A dry run writes nothing.
  expect(readBridged(INSTAGRAM, new Date(0), archive)).toEqual([]);
  expect(copyInstagramExport(root, { archive, bridges, now })).toEqual(dry);
  expect(copyInstagramExport(root, { archive, bridges, now })).toMatchObject({
    added: 0,
    duplicates: 6,
  });
  const read = readBridged(INSTAGRAM, new Date(0), archive);
  // With no bridge and no earlier copy, a chat is named by its export id and a person by their name.
  expect(read.map((e) => [e.chat, e.sender, e.text])).toEqual([
    ["10001", "Ana López", "Café at 5? \u{1f600}"],
    ["10002", "Ben Ito", "hello"],
    ["10001", "me", "https://example.com/reel/1"],
    ["10001", "Ana López", "Ana López started a video chat"],
    ["10001", "me", ""],
  ]);
  // The start and its end are one call of a minute.
  expect(read[3]?.phoneCall).toEqual({ seconds: 60, video: true });
  const [kept, ...tags] = read[4]?.files ?? [];
  expect(kept?.ref).toBe(`instagram:export:${T + 70_000}/1`);
  expect(kept?.path).toBe(join(archive, "media/instagram/export/10001/a.jpg"));
  expect(existsSync(kept?.path ?? "")).toBe(true);
  expect(tags.map((f) => f.path)).toEqual([undefined, undefined]);
  expect(
    incomingArchived("instagram", "eventId", undefined, archive).rows
  ).toEqual([]);
});

test("a chat lands where the archive already holds it: the bridge's room by the chat's id, else the chat sharing its instants; what is held is not doubled", () => {
  const { archive, bridges } = dirs();
  const root = exportOf({
    ana_10001: {
      messages: [0, 1, 2, 3, 4].map((i) =>
        said(i % 2 ? ME : "Ana", T + i * 60_000, { content: `m${i}` })
      ),
      other: "Ana",
    },
    ben_10002: { messages: BEN, other: "Ben Ito" },
  });
  // The bridge knows Ben's chat by its id; Beeper's copy holds four of Ana's five messages under its own chat, the
  // fourth stamped a little later.
  mkdirSync(join(bridges, "instagram"));
  const bridge = new Database(join(bridges, "instagram/instagram.db"));
  bridge.run(
    "create table portal (mxid text, other_user_id text, metadata text)"
  );
  bridge.run(
    `insert into portal values ('!ben:life.local', '777', '{"igid":"10002"}')`
  );
  bridge.close();
  const db = openBridged("instagram", archive);
  for (const i of [0, 1, 2, 3]) {
    db.run(
      `insert into messages (id, eventId, chat, chatName, sender, senderName, fromMe, at, type, text, deleted, seenAt)
       values (?, ?, '!beeper:beeper.local', 'Ana', '555', 'Ana', ?, ?, 'TEXT', ?, 0, '2026-10-01T00:00:00.000Z')`,
      [
        i,
        `$e${i}`,
        i % 2,
        new Date(T + i * 60_000 + (i === 3 ? 900 : 0)).toISOString(),
        `m${i}`,
      ]
    );
  }
  db.close();
  expect(copyInstagramExport(root, { archive, bridges })).toMatchObject({
    added: 2,
    duplicates: 4,
  });
  const added = readBridged(INSTAGRAM, new Date(0), archive).filter(
    (e) => e.id.endsWith(String(T + 4 * 60_000)) || e.chat === "!ben:life.local"
  );
  // Ana's fifth message joins Beeper's chat under the id Beeper gave her; Ben's is in the bridge's room, under the bridge's id for him.
  expect(added.map((e) => [e.chat, e.sender, e.text])).toEqual([
    ["!ben:life.local", "777", "hello"],
    ["!beeper:beeper.local", "555", "m4"],
  ]);
});

test("an export that does not say whose it is is refused", () => {
  const root = exportOf({ ana_10001: { messages: BEN, other: "Ana" } });
  expect(() => copyInstagramExport(root, { ...dirs(), dry: true })).toThrow(
    "does not say whose it is"
  );
});
