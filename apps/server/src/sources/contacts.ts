import type { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { log } from "../core/log";
import { APP_DATA } from "../core/platform";
import { openReadOnly } from "../core/sqlite";

// His Contacts: the Mac's AddressBook databases, opened read-only, never written. Each record is read whole: its name
// names the phone numbers and emails a source carries alone (iMessage), so a chat reads "Claire Dupont" rather than a
// number; the rest (birthday, work, addresses, family, profiles) are a person's details (`memory/details.ts`).

const DIR = join(APP_DATA, "AddressBook");
const FILE = "AddressBook-v22.abcddb";
/**
 * Digits a phone is known by: its national number, with or without a country code. A national number shorter than
 * this written both ways (a Thai landline) is missed, and reads as its number.
 */
const PHONE_DIGITS = 9;
/** Core Data's dates count seconds from 2001-01-01 UTC. */
const EPOCH_2001 = Date.UTC(2001, 0, 1);
/** A year Contacts stores for a birthday given without one (1604, or none). */
const YEAR_KNOWN_FROM = 1800;
/** A label Contacts names itself ("_$!<Home>!$_"); one he typed is plain. */
const BUILT_IN_LABEL = /^_\$!<(.*)>!\$_$/;
const NEWLINES = /\n/g;
/** The invisible direction marks a phone app wraps a number in ("\u202d+33 6…\u202c"). */
const DIRECTION_MARKS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
/** A link to a site's front page alone ("Facebook: http://www.facebook.com/"): a profile with no one in it. */
const SITE_ONLY = /: https?:\/\/[^/]+\/?$/;

/** A handle as Contacts and a source both write it: an email lower-cased, a phone by its last digits. */
export const handleKey = (h: string) =>
  h.includes("@")
    ? h.trim().toLowerCase()
    : h.replace(/\D/g, "").slice(-PHONE_DIGITS);

/** A handle's key when it can name someone: an email, or a phone with enough digits; else undefined. */
export const contactKeyOf = (h: string) => {
  const key = handleKey(h);
  return key.includes("@") || key.length >= PHONE_DIGITS ? key : undefined;
};

/** One Contacts record, whole. */
export interface Contact {
  /** Postal addresses, one line each, with their label ("12 rue Neuve, 44000 Nantes, France (Home)"). */
  addresses: string[];
  /** `YYYY-MM-DD`, or `--MM-DD` when Contacts has no year. */
  birthday: string | null;
  /** Its phone numbers and emails, as written. */
  handles: string[];
  /** The card's own id, which Photos' People link to (`ZUNIQUEID`). */
  id: string;
  /** The person's name, else the company's. */
  name: string | null;
  /** Social profiles ("Facebook: claire.d") and web addresses. */
  profiles: string[];
  /** Named relations ("Mother: Anne"). */
  related: string[];
  /** Job title, department and company of a person; null for a company's own record. */
  work: string | null;
}

interface RecordRow {
  birthday: number | null;
  company: string | null;
  department: string | null;
  first: string | null;
  id: number;
  last: string | null;
  title: string | null;
  uid: string;
  year: number | null;
}

/** "_$!<Home>!$_" (a label Contacts names) as "Home"; a label he typed as typed. */
const labelOf = (l: string | null) => l?.replace(BUILT_IN_LABEL, "$1") || null;

const joined = (parts: (string | null | undefined)[], sep = ", ") =>
  parts.filter(Boolean).join(sep) || null;

/** A birthday as Contacts stores it (seconds from 2001, at noon UTC, and the year apart) in Life's form. */
export function birthdayOf(seconds: number | null, year: number | null) {
  if (seconds === null) {
    return null;
  }
  const day = new Date(EPOCH_2001 + seconds * 1000).toISOString().slice(5, 10);
  return year && year >= YEAR_KNOWN_FROM
    ? `${String(year).padStart(4, "0")}-${day}`
    : `--${day}`;
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

/** `sql`'s rows (`owner`, `line`) as each record's lines. */
const linesBy = (db: Database, sql: string) =>
  Map.groupBy(
    db
      .query<{ line: string | null; owner: number }, []>(sql)
      .all()
      .filter((r) => r.line),
    (r) => r.owner
  );

/** The records of one database that have a phone or an email. */
function readFrom(file: string): Contact[] {
  const db = openReadOnly(file);
  try {
    const handles = linesBy(
      db,
      `select ZOWNER as owner, ZFULLNUMBER as line from ZABCDPHONENUMBER
       union all select ZOWNER, ZADDRESS from ZABCDEMAILADDRESS`
    );
    const addresses = db
      .query<
        {
          city: string | null;
          country: string | null;
          label: string | null;
          owner: number;
          street: string | null;
          zip: string | null;
        },
        []
      >(
        "select ZOWNER as owner, ZSTREET as street, ZZIPCODE as zip, ZCITY as city, ZCOUNTRYNAME as country, ZLABEL as label from ZABCDPOSTALADDRESS"
      )
      .all();
    const placed = Map.groupBy(addresses, (a) => a.owner);
    const related = db
      .query<{ label: string | null; name: string | null; owner: number }, []>(
        "select ZOWNER as owner, ZNAME as name, ZLABEL as label from ZABCDRELATEDNAME"
      )
      .all();
    const kin = Map.groupBy(related, (r) => r.owner);
    const profiles = linesBy(
      db,
      `select ZOWNER as owner, coalesce(nullif(ZSERVICENAME, '') || ': ', '') || coalesce(ZUSERNAME, ZURLSTRING) as line
         from ZABCDSOCIALPROFILE
       union all select ZOWNER, ZURL from ZABCDURLADDRESS`
    );
    const records = db
      .query<RecordRow, []>(
        `select Z_PK as id, ZFIRSTNAME as first, ZLASTNAME as last, ZORGANIZATION as company, ZJOBTITLE as title,
                ZDEPARTMENT as department, ZBIRTHDAY as birthday, ZBIRTHDAYYEAR as year,
                ZUNIQUEID as uid from ZABCDRECORD`
      )
      .all();
    return records.flatMap((r) => {
      const own = (handles.get(r.id) ?? []).map((h) =>
        (h.line as string).replace(DIRECTION_MARKS, "").trim()
      );
      if (own.length === 0) {
        return [];
      }
      const person = joined([r.first, r.last], " ");
      return [
        {
          addresses: (placed.get(r.id) ?? []).flatMap((a) => {
            const line = joined([
              a.street?.replace(NEWLINES, ", "),
              joined([a.zip, a.city], " "),
              a.country,
            ]);
            const label = labelOf(a.label);
            return line ? [label ? `${line} (${label})` : line] : [];
          }),
          birthday: birthdayOf(r.birthday, r.year),
          handles: own,
          id: r.uid,
          name: person ?? r.company,
          profiles: (profiles.get(r.id) ?? []).flatMap((p) =>
            SITE_ONLY.test(p.line as string) ? [] : [p.line as string]
          ),
          related: (kin.get(r.id) ?? []).flatMap((k) =>
            k.name ? [joined([labelOf(k.label), k.name], ": ") as string] : []
          ),
          work: person ? joined([r.title, r.department, r.company]) : null,
        },
      ];
    });
  } finally {
    db.close();
  }
}

/**
 * Every record with a phone or an email, from every AddressBook database under `dir`. One that can't be read is
 * logged and skipped: Contacts only add to what a source already holds, which reads as before (a number).
 */
export function readContactRecords(dir = DIR): Contact[] {
  const failed = (e: unknown) =>
    log("source.read", { error: String(e), ok: false, source: "contacts" });
  let files: string[] = [];
  try {
    files = databases(dir);
  } catch (e) {
    failed(e);
  }
  return files.flatMap((file) => {
    try {
      return readFrom(file);
    } catch (e) {
      failed(e);
      return [];
    }
  });
}

/**
 * Handle key -> the card that owns it: of the named cards holding a handle, the first by card id (a stable order,
 * whatever order the databases are read in). The one rule for whose a handle is in Contacts.
 */
export function ownersOf(contacts: Contact[]) {
  const owners = new Map<string, Contact & { name: string }>();
  for (const c of contacts.toSorted((a, b) => a.id.localeCompare(b.id))) {
    const { name } = c;
    for (const key of name ? c.handles.map(contactKeyOf) : []) {
      if (name && key && !owners.has(key)) {
        owners.set(key, { ...c, name });
      }
    }
  }
  return owners;
}

/** Handle key -> the name his Contacts give it (`ownersOf`). */
export const namesOf = (contacts: Contact[]) =>
  new Map([...ownersOf(contacts)].map(([key, c]) => [key, c.name]));

/** Handle key -> the name his Contacts give it, read now. */
export const readContacts = (dir = DIR) => namesOf(readContactRecords(dir));
