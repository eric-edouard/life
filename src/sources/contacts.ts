import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { log } from "../log";
import { TEST } from "../truth";

// His Contacts: the Mac's AddressBook databases, opened read-only, never written. They name the people behind the
// phone numbers and emails a source carries alone (iMessage), so a chat reads "Claire Dupont" rather than a number.

const DIR = join(homedir(), "Library", "Application Support", "AddressBook");
const FILE = "AddressBook-v22.abcddb";
/** Digits a phone is known by: its national number, with or without a country code. */
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

/** Handle key -> the name his Contacts give it, from every AddressBook database under `dir` (the Mac's and each account's). */
export function readContacts(dir = DIR) {
  const names = new Map<string, string>();
  try {
    const sources = join(dir, "Sources");
    const files = [
      join(dir, FILE),
      ...(existsSync(sources)
        ? readdirSync(sources).map((s) => join(sources, s, FILE))
        : []),
    ].filter(existsSync);
    for (const file of files) {
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
  } catch (e) {
    // Contacts only name what a source already holds: unreadable, the source reads as before (a number).
    log("source.read", { error: String(e), ok: false, source: "contacts" });
  }
  return names;
}

let read: Map<string, string> | undefined;
/** His Contacts, read once per process; none under `bun test` (tests never read his data). */
export const contacts = () => {
  read ??= TEST ? new Map() : readContacts();
  return read;
};
