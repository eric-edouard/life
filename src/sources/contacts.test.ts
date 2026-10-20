import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleKey, readContacts } from "./contacts";

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
