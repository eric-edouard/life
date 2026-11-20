import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  birthdayOf,
  contactKeyOf,
  handleKey,
  readContactPictures,
  readContactRecords,
  readContacts,
  writtenContactKeyOf,
} from "./contacts";

interface Made {
  birthday?: [number, number | null];
  company?: string;
  first?: string;
  handles: string[];
  last?: string;
  title?: string;
}

/** An AddressBook database at `path` with the tables Life reads, one record per `rows` entry. */
function make(
  path: string,
  rows: Made[],
  extra: (db: Database) => void = () => undefined
) {
  mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path);
  db.run(
    "create table ZABCDRECORD (Z_PK integer primary key, ZFIRSTNAME text, ZLASTNAME text, ZORGANIZATION text, ZJOBTITLE text, ZDEPARTMENT text, ZBIRTHDAY real, ZBIRTHDAYYEAR integer, ZUNIQUEID text)"
  );
  db.run("create table ZABCDPHONENUMBER (ZOWNER integer, ZFULLNUMBER text)");
  db.run("create table ZABCDEMAILADDRESS (ZOWNER integer, ZADDRESS text)");
  db.run(
    "create table ZABCDPOSTALADDRESS (ZOWNER integer, ZSTREET text, ZZIPCODE text, ZCITY text, ZCOUNTRYNAME text, ZLABEL text)"
  );
  db.run(
    "create table ZABCDRELATEDNAME (ZOWNER integer, ZNAME text, ZLABEL text)"
  );
  db.run(
    "create table ZABCDSOCIALPROFILE (ZOWNER integer, ZSERVICENAME text, ZUSERNAME text, ZURLSTRING text)"
  );
  db.run("create table ZABCDURLADDRESS (ZOWNER integer, ZURL text)");
  for (const [i, r] of rows.entries()) {
    db.run("insert into ZABCDRECORD values (?, ?, ?, ?, ?, null, ?, ?, ?)", [
      i + 1,
      r.first ?? null,
      r.last ?? null,
      r.company ?? null,
      r.title ?? null,
      r.birthday?.[0] ?? null,
      r.birthday?.[1] ?? null,
      `card-${i + 1}`,
    ]);
    for (const h of r.handles) {
      db.run(
        h.includes("@")
          ? "insert into ZABCDEMAILADDRESS values (?, ?)"
          : "insert into ZABCDPHONENUMBER values (?, ?)",
        [i + 1, h]
      );
    }
  }
  extra(db);
  db.close();
}

test("Contacts keys: a phone by its national digits whatever its country code or spacing, an email lower-cased", () => {
  expect(handleKey("+33 6 11 11 11 11")).toBe(handleKey("0611111111"));
  expect(handleKey("Claire@Example.COM ")).toBe("claire@example.com");
  expect(contactKeyOf("1234")).toBeUndefined();
  expect(contactKeyOf("Claire")).toBeUndefined();
});

test("a contact key of unknown kind: an address, or a number written with its +; a bare number only where numbers are phones", () => {
  expect(writtenContactKeyOf("+33 6 11 11 11 11")).toBe("611111111");
  expect(writtenContactKeyOf("\u202d+33 6 11 11 11 11\u202c")).toBe(
    "611111111"
  );
  expect(writtenContactKeyOf("Claire@Example.COM")).toBe("claire@example.com");
  for (const id of [
    "0611111111",
    "677777777",
    "17841400677777777",
    "U3a611111111fe0b",
    "123456789012@lid",
    "urn:biz:e1a2f3c4-1d22-4abc-99ca-9c12fb3adddd",
    "monnum:0611111111",
  ]) {
    expect(writtenContactKeyOf(id)).toBeUndefined();
  }
  expect(writtenContactKeyOf("06 11 11 11 11", true)).toBe("611111111");
  expect(writtenContactKeyOf("monnum:0611111111", true)).toBeUndefined();
});

test("Contacts birthdays: seconds from 2001 at noon UTC, the year kept only when Contacts knows it", () => {
  // 4.5 days after 2001-01-01: 5 Jan.
  expect(birthdayOf(388_800, 1992)).toBe("1992-01-05");
  expect(birthdayOf(388_800, 1604)).toBe("--01-05");
  expect(birthdayOf(388_800, null)).toBe("--01-05");
  expect(birthdayOf(null, 1992)).toBeNull();
  // 29 Feb with a year that has none is read without the year, never as a date that does not exist.
  const leapDay = (Date.UTC(2004, 1, 29, 12) - Date.UTC(2001, 0, 1)) / 1000;
  expect(birthdayOf(leapDay, 1990)).toBe("--02-29");
  expect(birthdayOf(leapDay, 1992)).toBe("1992-02-29");
});

test("Contacts read: names from the Mac's and each account's database, a person's name before a company's", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-"));
  make(join(dir, "AddressBook-v22.abcddb"), [
    { first: "Claire", handles: ["+33 6 11 11 11 11"], last: "Dupont" },
  ]);
  make(join(dir, "Sources", "acct", "AddressBook-v22.abcddb"), [
    { company: "Glass & Co", handles: ["02 22 22 22 22"] },
    { first: "Bob", handles: ["bob@example.com"] },
  ]);
  const names = readContacts(dir);
  expect(names.get(handleKey("0611111111"))).toBe("Claire Dupont");
  expect(names.get(handleKey("+33222222222"))).toBe("Glass & Co");
  expect(names.get("bob@example.com")).toBe("Bob");
  expect(readContacts(join(dir, "none")).size).toBe(0);
});

test("Contacts records: read whole (work, birthday, addresses, family, profiles); one with no handle is left out", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-"));
  make(
    join(dir, "AddressBook-v22.abcddb"),
    [
      {
        birthday: [388_800, 1990],
        company: "Acme",
        first: "Claire",
        // A phone app's invisible direction marks around the number.
        handles: ["\u202d+33 6 11 11 11 11\u202c", "claire@example.com"],
        title: "Designer",
      },
      { first: "Nobody", handles: [] },
    ],
    (db) => {
      db.run(
        "insert into ZABCDPOSTALADDRESS values (1, '12 rue Neuve', '44000', 'Nantes', 'France', '_$!<Home>!$_')"
      );
      db.run(
        "insert into ZABCDRELATEDNAME values (1, 'Anne', '_$!<Mother>!$_')"
      );
      db.run(
        "insert into ZABCDSOCIALPROFILE values (1, 'Facebook', 'claire.d', null)"
      );
      // A profile with no one in it: the service's front page.
      db.run(
        "insert into ZABCDSOCIALPROFILE values (1, 'Facebook', null, 'http://www.facebook.com/')"
      );
      db.run(
        "insert into ZABCDURLADDRESS values (1, 'https://claire.example')"
      );
    }
  );
  expect(readContactRecords(dir)).toEqual([
    {
      addresses: ["12 rue Neuve, 44000 Nantes, France (Home)"],
      birthday: "1990-01-05",
      handles: ["+33 6 11 11 11 11", "claire@example.com"],
      id: "card-1",
      name: "Claire",
      profiles: ["Facebook: claire.d", "https://claire.example"],
      related: ["Mother: Anne"],
      work: "Designer, Acme",
    },
  ]);
});

test("a card's picture: inline, in Core Data's external file, else its thumbnail", () => {
  const dir = mkdtempSync(join(tmpdir(), "contacts-pictures-"));
  const file = join(dir, "AddressBook-v22.abcddb");
  make(file, [{ handles: [] }, { handles: [] }, { handles: [] }], (db) => {
    db.run("alter table ZABCDRECORD add column ZIMAGEDATA blob");
    db.run("alter table ZABCDRECORD add column ZTHUMBNAILIMAGEDATA blob");
    db.run("update ZABCDRECORD set ZIMAGEDATA = ? where Z_PK = 1", [
      new Uint8Array([1, 0xff, 0xd8, 7]),
    ]);
    db.run("update ZABCDRECORD set ZIMAGEDATA = ? where Z_PK = 2", [
      new TextEncoder().encode("\u0002ABC-1\u0000"),
    ]);
    db.run(
      "update ZABCDRECORD set ZIMAGEDATA = ?, ZTHUMBNAILIMAGEDATA = ? where Z_PK = 3",
      [
        new TextEncoder().encode("\u0002GONE\u0000"),
        new Uint8Array([1, 0xff, 0xd8, 3]),
      ]
    );
  });
  const external = join(dir, ".AddressBook-v22_SUPPORT", "_EXTERNAL_DATA");
  mkdirSync(external, { recursive: true });
  writeFileSync(join(external, "ABC-1"), new Uint8Array([0x89, 0x50]));
  expect(readContactPictures(dir).map((p) => [p.card, [...p.bytes]])).toEqual([
    ["card-1", [0xff, 0xd8, 7]],
    ["card-2", [0x89, 0x50]],
    ["card-3", [0xff, 0xd8, 3]],
  ]);
});
