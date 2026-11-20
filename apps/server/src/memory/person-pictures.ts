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
import type { SourceName } from "../core/names";
import { readContactPictures, readContactRecords } from "../sources/contacts";
import type { Picture } from "../sources/contract";
import { toJpeg } from "./message-files";
import {
  PERSON_PICTURES,
  PERSON_PICTURES_INDEX,
  type PictureIndex,
  pictureFileOf,
} from "./party";
import { enabledSources } from "./sources";
import type { Resolve } from "./units";
import { readPeople } from "./who";

// The person pictures (docs/glossary.md): every picture a person shows, from his Contacts (his own choice) first, then
// each source in `SOURCES`' order, kept per Mac (`MACHINE_DIR`, never exported or backed up) for the apps, each once as
// a `PICTURE_PX` JPEG named by its id (`pictureIdOf`). Derived and rebuilt whole by the watcher each hour, never by the
// night; nothing in memory/. A picture someone changes is a new id, and the old file goes.

const CONTACTS = "contacts";
/** A kept picture's long side: 72 pt at 3x, the largest the apps draw. */
const PICTURE_PX = 216;

/** A picture's id: its original bytes' digest. */
export const pictureIdOf = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex").slice(0, 32);

/**
 * Each person's pictures, Contacts' first then each source's in the order given, the same picture once per person, and
 * the files they name. A card goes to its owner (`cardOwnerOf`), a source's picture to the first of its handles `resolve`
 * places (`who.ts`); one neither places is dropped.
 */
export function personPicturesOf(
  cards: { bytes: Uint8Array; card: { handles: string[]; id: string } }[],
  sources: { pictures: Picture[]; source: SourceName }[],
  people: {
    ownerOfCard: (card: {
      handles: string[];
      id: string;
    }) => string | undefined;
    resolve: Resolve;
  }
) {
  const index: PictureIndex = {};
  const files = new Map<string, Uint8Array>();
  const add = (
    person: string | null | undefined,
    source: string,
    bytes: Uint8Array
  ) => {
    if (!person) {
      return;
    }
    const id = pictureIdOf(bytes);
    const kept = index[person] ?? [];
    index[person] = kept;
    if (!kept.some((p) => p.id === id)) {
      kept.push({ id, source });
      files.set(id, bytes);
    }
  };
  for (const c of cards) {
    add(people.ownerOfCard(c.card), CONTACTS, c.bytes);
  }
  for (const s of sources) {
    for (const p of s.pictures) {
      add(
        p.handles.map((h) => people.resolve(h, s.source)).find(Boolean),
        s.source,
        p.bytes
      );
    }
  }
  return { files, index };
}

/**
 * Finds every person's pictures and keeps them: each new one made a `PICTURE_PX` JPEG (`toJpeg`; one it can't make is
 * left out of the index), the index (`{ built, people }`) replaced whole, then the files no one shows any more removed. A card is placed as Life places it (`readPeople`'s folds: an ambiguous card
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
  const kept = new Set<string>();
  for (const [id, bytes] of found.files) {
    const path = join(PERSON_PICTURES, pictureFileOf(id));
    // A stop midway leaves a `.src` or a `.tmp.jpg`, removed below, never a broken picture under its id.
    if (!existsSync(path)) {
      const src = `${path}.src`;
      writeFileSync(src, bytes);
      // biome-ignore lint/performance/noAwaitInLoops: one sips at a time, never thousands at once
      if (await toJpeg(src, `${path}.tmp.jpg`, PICTURE_PX)) {
        renameSync(`${path}.tmp.jpg`, path);
      }
    }
    if (existsSync(path)) {
      kept.add(pictureFileOf(id));
    }
  }
  const shown = Object.fromEntries(
    Object.entries(found.index).map(([ref, list]) => [
      ref,
      list.filter((p) => kept.has(pictureFileOf(p.id))),
    ])
  );
  writeJson(`${PERSON_PICTURES_INDEX}.tmp`, {
    built: iso(clock().getTime()),
    people: shown,
  });
  renameSync(`${PERSON_PICTURES_INDEX}.tmp`, PERSON_PICTURES_INDEX);
  for (const file of readdirSync(PERSON_PICTURES)) {
    if (!kept.has(file)) {
      rmSync(join(PERSON_PICTURES, file));
    }
  }
  return Object.keys(found.index).length;
}
