import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../log";
import { APP_DATA } from "../platform";

// His Contacts: the Mac's AddressBook databases, opened read-only, never written. They name the people behind the
// phone numbers and emails a source carries alone (iMessage), so a chat reads "Claire Dupont" rather than a number.

const DIR = join(APP_DATA, "AddressBook");
const FILE = "AddressBook-v22.abcddb";
/**
 * Digits a phone is known by: its national number, with or without a country code. A national number shorter than
 * this written both ways (a Thai landline) is missed, and reads as its number.
 */
const PHONE_DIGITS = 9;

/** A handle as Contacts and a source both write it: an email lower-cased, a phone by its last digits. */
export const handleKey = (h: string) =>
  h.includes("@")
    ? h.trim().toLowerCase()
    : h.replace(/\D/g, "").slice(-PHONE_DIGITS);

interface Row {
  company: string | null;
  first: string | null;
  handle: string | null;
  last: string | null;
}

/** The AddressBook databases under `dir`: the Mac's own and each account's. */
function databases(dir: string) {
  const sources = join(dir, "Sources");
  return [
    join(dir, FILE),
    ...(existsSync(sources)
      ? readdirSync(sources).map((s) => join(sources, s, FILE))
      : []),
  ].filter(existsSync);
}

/** The names one database gives, by handle key, into `names` (the first name a handle has wins). */
function readInto(file: string, names: Map<string, string>) {
  const db = new Database(file, { readonly: true });
  try {
    const rows = db
      .query<Row, []>(
        `select r.ZFIRSTNAME as first, r.ZLASTNAME as last, r.ZORGANIZATION as company, h.handle from (
           select ZOWNER as owner, ZFULLNUMBER as handle from ZABCDPHONENUMBER
           union all select ZOWNER, ZADDRESS from ZABCDEMAILADDRESS) h
         join ZABCDRECORD r on r.Z_PK = h.owner`
      )
      .all();
    for (const r of rows) {
      const name = [r.first, r.last].filter(Boolean).join(" ") || r.company;
      const key = r.handle ? handleKey(r.handle) : "";
      const usable = key.includes("@") || key.length >= PHONE_DIGITS;
      if (name && usable && !names.has(key)) {
        names.set(key, name);
      }
    }
  } finally {
    db.close();
  }
}

/**
 * Handle key -> the name his Contacts give it, from every AddressBook database under `dir`. One that can't be read
 * is logged and skipped: Contacts only name what a source already holds, which reads as before (a number).
 */
export function readContacts(dir = DIR) {
  const names = new Map<string, string>();
  const failed = (e: unknown) =>
    log("source.read", { error: String(e), ok: false, source: "contacts" });
  let files: string[] = [];
  try {
    files = databases(dir);
  } catch (e) {
    failed(e);
  }
  for (const file of files) {
    try {
      readInto(file, names);
    } catch (e) {
      failed(e);
    }
  }
  return names;
}
