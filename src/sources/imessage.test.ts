import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showFiles } from "../memory/files";
import { handleKey, readContacts } from "./contacts";
import { imessageFixture } from "./fixtures";
import {
  fromAppleNs,
  readImessage,
  textFromAttributedBody,
  toAppleNs,
} from "./imessage";

test("a photo-only message carries its attachments as files, a link preview left out", () => {
  const photo = join(mkdtempSync(join(tmpdir(), "att-")), "IMG_2910.HEIC");
  writeFileSync(photo, "bytes");
  // The text Messages keeps for a photo-only message: one U+FFFC.
  const db = imessageFixture(String.fromCharCode(0xff_fc), [
    { mime: "image/heic", name: "IMG_2910.HEIC", path: photo },
    // Never downloaded to this Mac, and Messages left its type out.
    { mime: null, name: "Audio Message.caf", path: null },
  ]);
  const read = (d: Date) => readImessage(d, db, new Map());
  const since = new Date(Date.now() - 3_600_000);
  expect(read(since)[0]?.files).toEqual([
    {
      mime: "image/heic",
      name: "IMG_2910.HEIC",
      path: photo,
      ref: "imessage:at_0",
    },
    { mime: "audio/x-caf", name: "Audio Message.caf", ref: "imessage:at_1" },
  ]);
  expect(showFiles(read(since), new Map())[0]?.text).toBe(
    "[photo IMG_2910.HEIC]\n[audio Audio Message.caf, not on this Mac]"
  );
});

test("Apple nanosecond dates round-trip", () => {
  const d = new Date("2026-10-10T12:00:00.000Z");
  expect(fromAppleNs(toAppleNs(d)).toISOString()).toBe(d.toISOString());
});

test("text is recovered from an archived attributed string", () => {
  const head = Buffer.from(
    "streamtyped\u0081è\u0003\u0084\u0001@\u0084\u0084\u0084\u0012NSAttributedString\u0000\u0084\u0084\u0008NSObject\u0000\u0085\u0092\u0084\u0084\u0084\u0008NSString",
    "latin1"
  );
  const body = Buffer.from("Ça marche, à demain", "utf8");
  const blob = Buffer.concat([
    head,
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, body.length]),
    body,
    Buffer.from([0x86]),
  ]);
  expect(textFromAttributedBody(blob)).toBe("Ça marche, à demain");
});

test("his Contacts name a 1:1 chat Messages knows only by its number; a chat's own name wins", () => {
  const db = imessageFixture("salut");
  const since = new Date(Date.now() - 3_600_000);
  // Contacts write the number their own way: the key is its last digits.
  const names = new Map([[handleKey("06 11 11 11 11"), "Claire Dupont"]]);
  expect(readImessage(since, db, names)[0]?.chatName).toBe("Claire Dupont");
  expect(readImessage(since, db, new Map())[0]?.chatName).toBeUndefined();
});

test("Contacts keys: a phone by its national digits whatever its country code or spacing, an email lower-cased", () => {
  expect(handleKey("+33 6 11 11 11 11")).toBe(handleKey("0611111111"));
  expect(handleKey("Claire@Example.COM ")).toBe("claire@example.com");
});

test("Contacts read: names from the Mac's and each account's database, a person's name before a company's", () => {
  const dir = mkdtempSync(join(tmpdir(), "ab-"));
  const make = (
    path: string,
    rows: [string | null, string | null, string | null, string][]
  ) => {
    mkdirSync(join(path, ".."), { recursive: true });
    const db = new Database(path);
    db.run(
      "create table ZABCDRECORD (Z_PK integer primary key, ZFIRSTNAME text, ZLASTNAME text, ZORGANIZATION text)"
    );
    db.run("create table ZABCDPHONENUMBER (ZOWNER integer, ZFULLNUMBER text)");
    db.run("create table ZABCDEMAILADDRESS (ZOWNER integer, ZADDRESS text)");
    for (const [i, [first, last, company, handle]] of rows.entries()) {
      db.run("insert into ZABCDRECORD values (?, ?, ?, ?)", [
        i + 1,
        first,
        last,
        company,
      ]);
      db.run(
        handle.includes("@")
          ? "insert into ZABCDEMAILADDRESS values (?, ?)"
          : "insert into ZABCDPHONENUMBER values (?, ?)",
        [i + 1, handle]
      );
    }
    db.close();
  };
  make(join(dir, "AddressBook-v22.abcddb"), [
    ["Claire", "Dupont", null, "+33 6 11 11 11 11"],
  ]);
  make(join(dir, "Sources", "acct", "AddressBook-v22.abcddb"), [
    [null, null, "Glass & Co", "02 22 22 22 22"],
    ["Bob", null, null, "bob@example.com"],
  ]);
  const names = readContacts(dir);
  expect(names.get(handleKey("0611111111"))).toBe("Claire Dupont");
  expect(names.get(handleKey("+33222222222"))).toBe("Glass & Co");
  expect(names.get("bob@example.com")).toBe("Bob");
  expect(readContacts(join(dir, "none")).size).toBe(0);
});
