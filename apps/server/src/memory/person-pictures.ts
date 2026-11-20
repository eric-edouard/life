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
import { log } from "../core/log";
import { LIFE_STATE_DIR } from "../core/paths";
import { readContactPictures, readContactRecords } from "../sources/contacts";
import type { Picture } from "../sources/contract";
import { whoseCardOf } from "./details";
import { readySources } from "./sources";
import { readPeople } from "./who";

// The person pictures (docs/glossary.md): every picture a person shows, from his Contacts (his own choice) first, then
// each source in `SOURCES`' order, kept in Life's state for the apps. Derived and rebuilt whole by the watcher each
// hour, never by the night; nothing in memory/. Each file is named by its bytes' digest, so a picture someone changes is
// a new file and the old one goes.

export const PERSON_PICTURES = join(LIFE_STATE_DIR, "person-pictures");
export const PERSON_PICTURES_INDEX = join(
  LIFE_STATE_DIR,
  "person-pictures.json"
);
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
 * the files they name. A card is placed by `cardRef`, a picture by the first of its handles `resolve` places (`who.ts`, the one way a sender becomes a
 * person); one neither places is dropped.
 */
export function personPicturesOf(
  cards: { bytes: Uint8Array; card: string }[],
  sources: { pictures: Picture[]; source: string }[],
  people: {
    cardRef: (card: string) => string | undefined;
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
    add(people.cardRef(c.card), CONTACTS, c.bytes);
  }
  for (const s of sources) {
    for (const p of s.pictures) {
      add(p.handles.map(people.resolve).find(Boolean), s.source, p.bytes);
    }
  }
  return { files, index };
}

/**
 * Finds every person's pictures and keeps them: new files written, the index (`{ built, people }`) replaced whole, then
 * the files no one shows any more removed. When a source can't be read, nothing changes: the last pictures stand.
 */
export async function writePersonPictures() {
  const failed: string[] = [];
  const read = <T>(source: string, pictures: () => T[]) => {
    try {
      return pictures();
    } catch (e) {
      failed.push(source);
      log("run.error", { error: String(e), step: `pictures.${source}` });
      return [];
    }
  };
  const people = await readPeople();
  const whose = whoseCardOf(people.resolve);
  const cards = new Map(readContactRecords().map((c) => [c.id, whose(c)]));
  const found = personPicturesOf(
    read(CONTACTS, () => readContactPictures()),
    readySources().flatMap((s) =>
      s.pictures ? [{ pictures: read(s.name, s.pictures), source: s.name }] : []
    ),
    { cardRef: (card) => cards.get(card), resolve: people.resolve }
  );
  if (failed.length > 0) {
    return 0;
  }
  mkdirSync(PERSON_PICTURES, { recursive: true });
  for (const [file, bytes] of found.files) {
    const path = join(PERSON_PICTURES, file);
    if (!existsSync(path)) {
      writeFileSync(path, bytes);
    }
  }
  const next = `${PERSON_PICTURES_INDEX}.tmp`;
  writeJson(next, { built: iso(clock().getTime()), people: found.index });
  renameSync(next, PERSON_PICTURES_INDEX);
  for (const file of readdirSync(PERSON_PICTURES)) {
    if (!found.files.has(file)) {
      rmSync(join(PERSON_PICTURES, file));
    }
  }
  return Object.keys(found.index).length;
}
