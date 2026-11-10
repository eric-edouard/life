import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAppleS } from "./imessage";
import {
  copyScreen,
  newestScreen,
  parseSegb,
  readScreen,
  stintsOf,
} from "./screen";

// Made-up Biome files: protobuf records in a SEGB v2 file, as Biome writes them.

const varint = (n: number) => {
  const out: number[] = [];
  let x = n;
  while (x >= 0x80) {
    out.push((x % 0x80) + 0x80);
    x = Math.floor(x / 0x80);
  }
  out.push(x);
  return out;
};
type Value = number | string | { double: number };
/** A protobuf message: a number is a varint, a string bytes, `{double}` a fixed64. */
const message = (fields: Record<number, Value>) =>
  Buffer.concat(
    Object.entries(fields).map(([n, v]) => {
      if (typeof v === "number") {
        return Buffer.from([...varint(Number(n) * 8), ...varint(v)]);
      }
      if (typeof v === "string") {
        const bytes = Buffer.from(v);
        return Buffer.concat([
          Buffer.from([...varint(Number(n) * 8 + 2), ...varint(bytes.length)]),
          bytes,
        ]);
      }
      const d = Buffer.alloc(8);
      d.writeDoubleLE(v.double);
      return Buffer.concat([Buffer.from(varint(Number(n) * 8 + 1)), d]);
    })
  );
/** A SEGB v2 file of `records`, each kept (state 1) unless `pruned` (state 3, blanked), `size` bytes long when given. */
function segb(records: { data: Buffer; pruned?: boolean }[], size?: number) {
  const body: Buffer[] = [];
  const table: Buffer[] = [];
  let at = 0;
  for (const r of records) {
    const pad = (4 - (at % 4)) % 4;
    body.push(Buffer.alloc(pad));
    at += pad;
    const data = r.pruned ? Buffer.alloc(r.data.length) : r.data;
    body.push(Buffer.alloc(8), data);
    at += 8 + data.length;
    const entry = Buffer.alloc(16);
    entry.writeUInt32LE(at, 0);
    entry.writeUInt32LE(r.pruned ? 3 : 1, 4);
    table.unshift(entry);
  }
  const head = Buffer.alloc(32);
  head.write("SEGB", 0, "latin1");
  head.writeUInt32LE(records.length, 4);
  const used = 32 + at + 16 * records.length;
  return Buffer.concat([
    head,
    ...body,
    Buffer.alloc(size ? size - used : 0),
    ...table,
  ]);
}

const MAC = "MAC-1";
const PHONE = "PHONE-1";
const T0 = Date.parse("2026-03-10T02:00:00Z");
const at = (min: number) => T0 + min * 60_000;
const apple = (min: number) => ({ double: toAppleS(at(min)) });
/** The Mac's app time (Screen Time's stream: unix seconds), the phone's app in front, a Safari visit. */
const macApp = (min: number, bundle: string, starting: boolean) =>
  message({ 1: Number(starting), 2: { double: at(min) / 1000 }, 3: bundle });
const phoneApp = (min: number, bundle: string, starting: boolean) =>
  message({ 3: Number(starting), 4: apple(min), 6: bundle });
const visit = (min: number, id: string, domain: string, starting: boolean) =>
  message({
    1: id,
    2: apple(min),
    3: starting ? 3 : 1,
    5: domain,
    6: "com.apple.Safari",
  });

/** A made-up Biome folder: its sync database naming this Mac and a phone, and the given files. */
function biomeFixture(files: Record<string, Buffer>) {
  const root = mkdtempSync(join(tmpdir(), "life-biome-"));
  mkdirSync(join(root, "sync"), { recursive: true });
  const db = new Database(join(root, "sync/sync.db"));
  db.run(
    "create table DevicePeer (device_identifier text, me boolean, platform integer)"
  );
  db.run("insert into DevicePeer values (?, 1, 3), (?, 0, 2)", [MAC, PHONE]);
  db.close();
  const write = (path: string, bytes: Buffer) => {
    const full = join(root, "streams/restricted", path);
    mkdirSync(join(full, ".."), { recursive: true });
    writeFileSync(full, bytes);
  };
  for (const [path, bytes] of Object.entries(files)) {
    write(path, bytes);
  }
  return { archive: join(root, "archive"), root, write };
}

test("a SEGB file gives its kept records only, in order", () => {
  const a = message({ 6: "a" });
  const b = message({ 6: "bb" });
  const c = message({ 6: "ccc" });
  expect(
    parseSegb(segb([{ data: a }, { data: b, pruned: true }, { data: c }])).map(
      (r) => Buffer.from(r).toString("hex")
    )
  ).toEqual([a.toString("hex"), c.toString("hex")]);
  expect(() => parseSegb(Buffer.from("nope"))).toThrow();
  // Its count raised before its last entry is written.
  const torn = segb([{ data: a }, { data: b }]);
  torn.fill(0, torn.length - 32, torn.length - 16);
  expect(() => parseSegb(torn)).toThrow("still being written");
});

test("each device's records are copied once; one synced late with an older time still lands", () => {
  const { archive, root, write } = biomeFixture({
    "App.WebUsage/local/1": segb([
      { data: visit(0, "v1", "example.org", true) },
      { data: visit(12, "v1", "example.org", false) },
    ]),
    "ScreenTime.AppUsage/local/1": segb([
      { data: macApp(0, "com.example.editor", true) },
      { data: macApp(30, "com.example.editor", false) },
    ]),
  });
  expect(copyScreen(root, archive)).toBe(4);
  expect(copyScreen(root, archive)).toBe(0);
  write(
    `App.InFocus/remote/${PHONE}/1`,
    segb([
      { data: phoneApp(-60, "com.example.chat", true) },
      { data: phoneApp(-50, "com.example.chat", false) },
    ])
  );
  expect(copyScreen(root, archive)).toBe(2);
  const events = readScreen(new Date(at(-120)), archive, root);
  expect(
    events.map((e) => [e.chat, e.chatName, e.text, e.at, e.until])
  ).toEqual([
    [
      PHONE,
      "iOS device",
      "com.example.chat",
      new Date(at(-60)).toISOString(),
      new Date(at(-50)).toISOString(),
    ],
    [
      MAC,
      "Mac",
      "com.example.editor",
      new Date(at(0)).toISOString(),
      new Date(at(30)).toISOString(),
    ],
    [
      MAC,
      "Mac",
      "web: example.org",
      new Date(at(0)).toISOString(),
      new Date(at(12)).toISOString(),
    ],
  ]);
});

test("stints: the next app ends the one in front, frames end it but are left out, the same app back within 2 minutes is one", () => {
  const record = (min: number, bundle: string, starting: number) => ({
    at: new Date(at(min)).toISOString(),
    bundle,
    device: PHONE,
    domain: "",
    starting,
    visit: "",
  });
  const stints = stintsOf(
    [
      record(0, "com.example.chat", 1),
      // An end of another app ends nothing.
      record(2, "com.example.maps", 0),
      record(5, "com.apple.springboard", 1),
      record(6, "com.example.chat", 1),
      record(10, "com.example.chat", 0),
      record(10, "com.apple.InCallService", 1),
      record(20, "com.apple.InCallService", 0),
      record(30, "com.example.chat", 1),
      record(31, "com.example.chat", 0),
    ],
    "app"
  ).map((s) => [s.what, s.at.slice(11, 16), s.until.slice(11, 16)]);
  expect(stints).toEqual([
    ["com.example.chat", "02:00", "02:10"],
    ["com.apple.InCallService", "02:10", "02:20"],
    ["com.example.chat", "02:30", "02:31"],
  ]);
});

test("a file that fails stops no other, and is copied once it reads", () => {
  const { archive, root, write } = biomeFixture({
    "App.WebUsage/local/1": segb([
      { data: visit(0, "v1", "example.org", true) },
      { data: visit(12, "v1", "example.org", false) },
    ]),
    // Biome still writing it.
    "ScreenTime.AppUsage/local/1": Buffer.alloc(0),
  });
  expect(() => copyScreen(root, archive)).toThrow("not a SEGB v2 file");
  expect(readScreen(new Date(at(-1)), archive, root)).toHaveLength(1);
  expect(() => copyScreen(root, archive)).toThrow();
  write(
    "ScreenTime.AppUsage/local/1",
    segb([
      { data: macApp(0, "com.example.editor", true) },
      { data: macApp(30, "com.example.editor", false) },
    ])
  );
  expect(copyScreen(root, archive)).toBe(2);
});

test("a record written into a file of the same size and time is still copied", () => {
  const path = `App.InFocus/remote/${PHONE}/1`;
  const first = { data: phoneApp(0, "com.example.chat", true) };
  const { archive, root, write } = biomeFixture({
    [path]: segb([first], 1024),
  });
  const full = join(root, "streams/restricted", path);
  const then = new Date(T0);
  utimesSync(full, then, then);
  expect(copyScreen(root, archive)).toBe(1);
  write(
    path,
    segb([first, { data: phoneApp(10, "com.example.chat", false) }], 1024)
  );
  utimesSync(full, then, then);
  expect(copyScreen(root, archive)).toBe(1);
});

test("the card counts only devices still in use: a retired phone and one Biome no longer syncs turn nothing amber", () => {
  const { archive, root } = biomeFixture({
    "App.InFocus/remote/GONE-1/1": segb([
      { data: phoneApp(-900, "com.example.chat", true) },
    ]),
    "App.InFocus/remote/OLD-PHONE/1": segb([
      { data: phoneApp(-600, "com.example.chat", true) },
    ]),
    [`App.InFocus/remote/${PHONE}/1`]: segb([
      { data: phoneApp(-5, "com.example.chat", true) },
    ]),
    "ScreenTime.AppUsage/local/1": segb([
      { data: macApp(-30, "com.example.editor", true) },
    ]),
  });
  const db = new Database(join(root, "sync/sync.db"));
  db.run("insert into DevicePeer values ('OLD-PHONE', 0, 2)");
  db.close();
  copyScreen(root, archive);
  expect(newestScreen(archive, root).parts).toEqual([
    { at: new Date(at(-5)).toISOString(), label: "iOS device" },
    { at: new Date(at(-30)).toISOString(), label: "Mac" },
  ]);
});

test("month-end app and website stints retain joined context and belong only to their start month", () => {
  const boundary = Date.parse("2026-04-01T00:00:00Z");
  const min = (boundary - T0) / 60_000;
  const { archive, root } = biomeFixture({
    "App.WebUsage/local/1": segb([
      { data: visit(min - 5, "boundary", "example.org", true) },
      { data: visit(min + 5, "boundary", "example.org", false) },
      { data: visit(min + 6, "next", "example.org", true) },
      { data: visit(min + 10, "next", "example.org", false) },
    ]),
    "ScreenTime.AppUsage/local/1": segb([
      { data: macApp(min - 5, "com.example.editor", true) },
      { data: macApp(min + 5, "com.example.editor", false) },
      { data: macApp(min + 6, "com.example.editor", true) },
      { data: macApp(min + 10, "com.example.editor", false) },
      { data: macApp(min + 30, "com.example.chat", true) },
      { data: macApp(min + 40, "com.example.chat", false) },
    ]),
  });
  copyScreen(root, archive);
  const march = readScreen(
    new Date("2026-03-01"),
    archive,
    root,
    new Date(boundary)
  );
  expect(march.map((e) => [e.text, e.at, e.until])).toEqual([
    [
      "com.example.editor",
      "2026-03-31T23:55:00.000Z",
      "2026-04-01T00:10:00.000Z",
    ],
    [
      "web: example.org",
      "2026-03-31T23:55:00.000Z",
      "2026-04-01T00:10:00.000Z",
    ],
  ]);
  const april = readScreen(
    new Date(boundary),
    archive,
    root,
    new Date("2026-05-01")
  );
  expect(april.map((e) => e.text)).toEqual(["com.example.chat"]);
});
