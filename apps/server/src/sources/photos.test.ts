import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceEvent } from "../records/source";
import type { Contact } from "./contacts";
import { toAppleS } from "./imessage";
import { earliestPhoto, newestPhoto, readPhotos } from "./photos";

// A made-up Photos library: the tables and columns read only, as Photos and its search index name them.

/** An NSKeyedArchiver postal address (street "1 Example Road", city "Exampleville", country "Examplia"). */
const ADDRESS = Buffer.from(
  "YnBsaXN0MDDTAQIDBAUIWSRhcmNoaXZlclQkdG9wWCRvYmplY3RzXxAPTlNLZXllZEFyY2hpdmVy0QYHVHJvb3SAAaYJCg8YGRpVJG51bGzSCwwNDl1wb3N0YWxBZGRyZXNzVmlzSG9tZYACCNQQERITFBUWF1VfY2l0eVdfc3RyZWV0WF9jb3VudHJ5XF9zdWJMb2NhbGl0eYAEgAOABYAAXjEgRXhhbXBsZSBSb2FkXEV4YW1wbGV2aWxsZVhFeGFtcGxpYQgPGR4nOTxBQ0pQVWNqbG12fISNmpyeoKKxvgAAAAAAAAEBAAAAAAAAABsAAAAAAAAAAAAAAAAAAADH",
  "base64"
);
const atApple = (iso: string) => toAppleS(Date.parse(iso));
const lexemes = (...ids: number[]) => Buffer.from(new Int32Array(ids).buffer);

interface Asset {
  address?: Buffer;
  burst?: boolean;
  caption?: string;
  date?: string;
  favorite?: number;
  hidden?: number;
  kind?: number;
  lat?: number;
  lexemes?: number[];
  lon?: number;
  moment?: number;
  screenshot?: number;
  trashed?: number;
  uuid: string;
  zone?: string;
}

function library(assets: Asset[], faces: [string, number][] = []) {
  const dir = mkdtempSync(join(tmpdir(), "photos-"));
  mkdirSync(join(dir, "search"));
  const db = new Database(join(dir, "Photos.sqlite"));
  db.run(`create table ZASSET (Z_PK integer primary key, ZUUID text, ZDATECREATED real, ZKIND integer, ZFAVORITE integer,
    ZLATITUDE real, ZLONGITUDE real, ZMOMENT integer, ZTRASHEDSTATE integer, ZHIDDEN integer,
    ZISDETECTEDSCREENSHOT integer, ZVISIBILITYSTATE integer)`);
  db.run(
    "create table ZADDITIONALASSETATTRIBUTES (Z_PK integer primary key, ZASSET integer, ZTIMEZONENAME text, ZREVERSELOCATIONDATA blob, ZTITLE text)"
  );
  db.run(
    "create table ZASSETDESCRIPTION (ZASSETATTRIBUTES integer, ZLONGDESCRIPTION text)"
  );
  db.run("create table ZMOMENT (Z_PK integer primary key, ZTITLE text)");
  db.run("insert into ZMOMENT values (1, 'Seaside'), (2, null)");
  db.run(
    "create table ZDETECTEDFACE (ZASSETFORFACE integer, ZPERSONFORFACE integer)"
  );
  db.run(`create table ZPERSON (Z_PK integer primary key, ZMERGETARGETPERSON integer, ZFULLNAME text,
    ZDISPLAYNAME text, ZPERSONURI text, ZISMECONFIDENCE real)`);
  // 1 Ana (linked to a Contacts card), 2 merged into 1, 3 Tom (no card), 4 the owner, 5 unnamed.
  db.run(`insert into ZPERSON values
    (1, null, 'Ana Test', 'Ana', 'card-1:ABPerson', 0), (2, 1, null, null, null, 0), (3, null, null, 'Tom', null, 0),
    (4, null, 'Me Myself', 'Me', null, 1), (5, null, null, null, null, 0)`);
  const search = new Database(join(dir, "search", "leo.sqlite"));
  search.run("create table items (identifier text, lexeme_ids blob)");
  search.run(
    "create table lexicon (lexeme_id integer, category integer, content text)"
  );
  search.run(`insert into lexicon values
    (1, 4000, 'Beach'), (2, 4000, 'Sunset'), (3, 4120, 'open'), (4, 4120, 'daily'), (5, 3000, 'ignored')`);
  for (const [i, a] of assets.entries()) {
    const pk = i + 1;
    db.run("insert into ZASSET values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      pk,
      a.uuid,
      atApple(a.date ?? "2026-10-10T10:00:00Z"),
      a.kind ?? 0,
      a.favorite ?? 0,
      a.lat ?? -180,
      a.lon ?? -180,
      a.moment ?? 1,
      a.trashed ?? 0,
      a.hidden ?? 0,
      a.screenshot ?? 0,
      a.burst ? 2 : 0,
    ]);
    db.run("insert into ZADDITIONALASSETATTRIBUTES values (?, ?, ?, ?, null)", [
      pk,
      pk,
      a.zone ?? "Europe/Paris",
      a.address ?? null,
    ]);
    if (a.caption) {
      db.run("insert into ZASSETDESCRIPTION values (?, ?)", [pk, a.caption]);
    }
    search.run("insert into items values (?, ?)", [
      a.uuid,
      lexemes(...(a.lexemes ?? [])),
    ]);
  }
  for (const [uuid, person] of faces) {
    const pk = assets.findIndex((a) => a.uuid === uuid) + 1;
    db.run("insert into ZDETECTEDFACE values (?, ?)", [pk, person]);
  }
  db.close();
  search.close();
  return dir;
}

const card = (over: Partial<Contact>): Contact => ({
  addresses: [],
  birthday: null,
  handles: [],
  id: "card-1:ABPerson",
  name: "Ana Contact",
  profiles: [],
  related: [],
  work: null,
  ...over,
});

const since = new Date("2026-10-01T00:00:00Z");

test("a photo is one event of its day: Apple's place, address, point, scenes, words, caption, zone and favourite", () => {
  const dir = library([
    {
      address: ADDRESS,
      caption: "Our first swim",
      favorite: 1,
      lat: 48.856_612_3,
      lexemes: [1, 2, 3, 4, 5],
      lon: 2.352_219_8,
      uuid: "A1",
      zone: "Asia/Bangkok",
    },
    { kind: 1, moment: 2, uuid: "A2" },
  ]);
  const events = readPhotos(since, undefined, dir, []);
  expect(events.map((e) => SourceEvent.parse(e).id)).toEqual([
    "photos:A1",
    "photos:A2",
  ]);
  expect(events[0]).toEqual({
    at: "2026-10-10T10:00:00.000Z",
    chat: "photos",
    chatName: "Photos",
    fromMe: true,
    id: "photos:A1",
    photo: {
      address: "1 Example Road, Exampleville, Examplia",
      caption: "Our first swim",
      favorite: true,
      ocr: "open daily",
      pictured: [],
      place: "Seaside",
      point: { lat: 48.8566, lon: 2.3522 },
      scenes: ["Beach", "Sunset"],
      zone: "Asia/Bangkok",
    },
    sender: "me",
    source: "photos",
    text: 'photo · Seaside · 1 Example Road, Exampleville, Examplia · Beach, Sunset · "Our first swim" · text: open daily',
  });
  // No coordinates (-180), no place, no scenes: a video with nothing else.
  expect(events[1]?.photo).toEqual({
    pictured: [],
    scenes: [],
    video: true,
    zone: "Europe/Paris",
  });
  expect(events[1]?.text).toBe("video");
});

test("trashed, hidden, screenshots, unpicked burst frames and undated photos are left out; the window is from `since` to `before`", () => {
  const dir = library([
    { uuid: "keep" },
    { trashed: 1, uuid: "trashed" },
    { hidden: 1, uuid: "hidden" },
    { screenshot: 1, uuid: "screenshot" },
    { burst: true, uuid: "burst" },
    { date: "1970-01-01T00:00:00Z", uuid: "undated" },
    { date: "2026-09-30T23:59:00Z", uuid: "before-window" },
    { date: "2026-10-20T00:00:00Z", uuid: "after-window" },
  ]);
  const read = (before?: Date) =>
    readPhotos(since, before, dir, []).map((e) => e.id);
  expect(read(new Date("2026-10-15T00:00:00Z"))).toEqual(["photos:keep"]);
  expect(read()).toEqual(["photos:keep", "photos:after-window"]);
  expect(earliestPhoto(dir)).toBe("2026-09-30T23:59:00.000Z");
  expect(newestPhoto(dir).at).toBe("2026-10-20T00:00:00.000Z");
});

test("who is pictured: Apple's named people, a merged one as its target, the owner and the unnamed left out, a Contacts handle with the name", () => {
  const dir = library(
    [{ uuid: "group" }, { uuid: "tom" }],
    [
      ["group", 1],
      ["group", 2],
      ["group", 3],
      ["group", 4],
      ["group", 5],
      ["tom", 3],
    ]
  );
  const [group, tom] = readPhotos(since, undefined, dir, [
    card({ handles: ["+33 6 11 11 11 11", "ana@example.com"] }),
    card({ handles: ["+33 6 99 99 99 99"], id: "other-card" }),
  ]);
  expect(group?.photo?.pictured).toEqual([
    { handle: "+33 6 11 11 11 11", name: "Ana Test" },
    { name: "Tom" },
  ]);
  expect(group?.text).toBe("photo · Seaside · with Ana Test, Tom");
  expect(tom?.photo?.pictured).toEqual([{ name: "Tom" }]);
  // A Contacts card Photos links to but that has no phone or email: the name alone.
  expect(
    readPhotos(since, undefined, dir, [card({ handles: [] })])[0]?.photo
      ?.pictured[0]
  ).toEqual({ name: "Ana Test" });
});
