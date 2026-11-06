import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  birthdayOf,
  contactKeyOf,
  handleKey,
  readContactRecords,
  readContacts,
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
    "create table ZABCDRECORD (Z_PK integer primary key, ZFIRSTNAME text, ZLASTNAME text, ZORGANIZATION text, ZJOBTITLE text, ZDEPARTMENT text, ZBIRTHDAY real, ZBIRTHDAYYEAR integer)"
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
    db.run("insert into ZABCDRECORD values (?, ?, ?, ?, ?, null, ?, ?)", [
      i + 1,
      r.first ?? null,
      r.last ?? null,
      r.company ?? null,
      r.title ?? null,
      r.birthday?.[0] ?? null,
      r.birthday?.[1] ?? null,
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

test("Contacts birthdays: seconds from 2001 at noon UTC, the year kept only when Contacts knows it", () => {
  // 4.5 days after 2001-01-01: 5 Jan.
  expect(birthdayOf(388_800, 1992)).toBe("1992-01-05");
  expect(birthdayOf(388_800, 1604)).toBe("--01-05");
  expect(birthdayOf(388_800, null)).toBe("--01-05");
  expect(birthdayOf(null, 1992)).toBeNull();
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
        handles: ["+33 6 11 11 11 11", "claire@example.com"],
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
      name: "Claire",
      profiles: ["Facebook: claire.d", "https://claire.example"],
      related: ["Mother: Anne"],
      work: "Designer, Acme",
    },
  ]);
});
