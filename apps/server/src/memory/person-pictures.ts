import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clock, iso } from "../core/clock";
import { writeJson } from "../core/files";
import { MACHINE_DIR } from "../core/platform";
import { readContactPictures, readContactRecords } from "../sources/contacts";
import type { Picture } from "../sources/contract";
import { enabledSources } from "./sources";
import { readPeople } from "./who";

// The person pictures (docs/glossary.md): every picture a person shows, from his Contacts (his own choice) first, then
// each source in `SOURCES`' order, kept per Mac (`MACHINE_DIR`, never exported or backed up) for the apps. Derived and rebuilt whole by the watcher each
// hour, never by the night; nothing in memory/. Each file is named by its bytes' digest, so a picture someone changes is
// a new file and the old one goes.

export const PERSON_PICTURES = join(MACHINE_DIR, "person-pictures");
export const PERSON_PICTURES_INDEX = join(MACHINE_DIR, "person-pictures.json");
const CONTACTS = "contacts";

/** A file's extension from its first bytes: the formats a source's pictures come in. */
const FORMATS: [string, number[]][] = [
  ["jpg", [0xff, 0xd8]],
  ["png", [0x89, 0x50, 0x4e, 0x47]],
  ["gif", [0x47, 0x49, 0x46]],
  ["webp", [0x52, 0x49, 0x46, 0x46]],
  ["tiff", [0x4d, 0x4d]],
  ["tiff", [0x49, 0x49]],
];
const extOf = (bytes: Uint8Array) =>
  FORMATS.find(([, magic]) => magic.every((b, i) => bytes[i] === b))?.[0] ??
  "img";

/** A picture's file name: its digest and its format. */
export const pictureFileOf = (bytes: Uint8Array) =>
  `${createHash("sha256").update(bytes).digest("hex").slice(0, 32)}.${extOf(bytes)}`;

/**
 * Each person's pictures, Contacts' first then each source's in the order given, the same picture once per person, and
 * the files they name. A card goes to its owner (`cardOwnerOf`), a source's picture to the first of its handles `resolve`
 * places (`who.ts`); one neither places is dropped.
 */
export function personPicturesOf(
  cards: { bytes: Uint8Array; card: { handles: string[]; id: string } }[],
  sources: { pictures: Picture[]; source: string }[],
  people: {
    ownerOfCard: (card: {
      handles: string[];
      id: string;
    }) => string | undefined;
    resolve: (handle: string) => string | null;
  }
) {
  const index: Record<string, { file: string; source: string }[]> = {};
  const files = new Map<string, Uint8Array>();
  const add = (
    person: string | null | undefined,
    source: string,
    bytes: Uint8Array
  ) => {
    if (!person) {
      return;
    }
    const file = pictureFileOf(bytes);
    const kept = index[person] ?? [];
    index[person] = kept;
    if (!kept.some((p) => p.file === file)) {
      kept.push({ file, source });
      files.set(file, bytes);
    }
  };
  for (const c of cards) {
    add(people.ownerOfCard(c.card), CONTACTS, c.bytes);
  }
  for (const s of sources) {
    for (const p of s.pictures) {
      add(p.handles.map(people.resolve).find(Boolean), s.source, p.bytes);
    }
  }
  return { files, index };
}

/** Writes `bytes` to `path` whole: a stop midway leaves a `.tmp`, never a broken picture under its digest. */
function writeWhole(path: string, write: (to: string) => void) {
  write(`${path}.tmp`);
  renameSync(`${path}.tmp`, path);
}

/**
 * Finds every person's pictures and keeps them: new files written, the index (`{ built, people }`) replaced whole, then
 * the files no one shows any more removed. A card is placed as Life places it (`readPeople`'s folds: an ambiguous card
 * stays its own). A reader returns nothing for what isn't there and throws when it can't read: then nothing changes,
 * the last pictures stand (the watcher logs why). ponytail: one reader failing for good freezes them all; per-source
 * keeping if that ever happens.
 */
export async function writePersonPictures() {
  const people = await readPeople();
  const records = new Map(readContactRecords().map((c) => [c.id, c]));
  const found = personPicturesOf(
    readContactPictures().map((p) => ({
      bytes: p.bytes,
      card: records.get(p.card) ?? { handles: [], id: p.card },
    })),
    enabledSources().flatMap((s) =>
      s.pictures ? [{ pictures: s.pictures(), source: s.name }] : []
    ),
    people
  );
  mkdirSync(PERSON_PICTURES, { recursive: true });
  for (const [file, bytes] of found.files) {
    const path = join(PERSON_PICTURES, file);
    if (!existsSync(path)) {
      writeWhole(path, (to) => writeFileSync(to, bytes));
    }
  }
  writeWhole(PERSON_PICTURES_INDEX, (to) =>
    writeJson(to, { built: iso(clock().getTime()), people: found.index })
  );
  for (const file of readdirSync(PERSON_PICTURES)) {
    if (!found.files.has(file)) {
      rmSync(join(PERSON_PICTURES, file));
    }
  }
  return Object.keys(found.index).length;
}
