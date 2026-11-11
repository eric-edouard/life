import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Plist, readBplist, type Uid } from "../core/bplist";
import { iso } from "../core/clock";
import { within } from "../core/lists";
import { HOME } from "../core/platform";
import { openReadOnly } from "../core/sqlite";
import type { Photo, SourceEvent } from "../records/source";
import { type Contact, readContactRecords } from "./contacts";
import type { Newest } from "./contract";
import { fromAppleS, toAppleS } from "./imessage";

// His photos and videos from the Mac's Photos library, opened read-only. Never written, never copied: Photos keeps its own
// history (Recently Deleted, iCloud), and no image, face or face print is read, only what Apple's analysis and he wrote
// about each photo. Photos' own store and its search index (`leo.sqlite`, where the scene labels and the text found in
// a photo are kept as numbered words) are macOS-versioned: a column Apple drops fails the read by its name.

export const LIBRARY = join(
  HOME,
  "Pictures",
  "Photos Library.photoslibrary",
  "database"
);
const STORE = "Photos.sqlite";
export const PHOTOS_DB = join(LIBRARY, STORE);
const SEARCH_INDEX = join("search", "leo.sqlite");

/** The search index's categories: a scene label (Beach), a word found in the photo. */
const SCENE = 4000;
const OCR = 4120;
/** The words found in photos, as shown, in characters at most. */
const OCR_MAX = 300;
/** A coordinate Photos has none for. */
const NO_COORDINATE = -180;
/** `ZISMECONFIDENCE`, from which a person Photos knows is the owner. */
const OWNER_CONFIDENCE = 0.5;
/** `ZKIND` of a video. */
const VIDEO = 1;

/**
 * Not trashed, hidden or a screenshot, the frame of a burst he picked, and dated: Photos dates what it cannot place at
 * 1 Jan 1970, before its own epoch (2001).
 */
const SHOWN =
  "a.ZTRASHEDSTATE = 0 and a.ZHIDDEN = 0 and a.ZISDETECTEDSCREENSHOT = 0 and a.ZVISIBILITYSTATE = 0 and a.ZDATECREATED > 0";
const WINDOW = "a.ZDATECREATED >= ? and (? is null or a.ZDATECREATED < ?)";

interface Row {
  address: Uint8Array | null;
  caption: string | null;
  date: number;
  favorite: number;
  kind: number;
  lat: number;
  lon: number;
  offset: number | null;
  pk: number;
  place: string | null;
  uuid: string;
  zone: string | null;
}

interface PersonRow {
  confidence: number;
  id: number;
  merged: number | null;
  name: string | null;
  uri: string | null;
}

/** Photos' lexeme blobs are lists of little-endian int32 ids into the index's lexicon. */
function lexemesOf(blob: Uint8Array) {
  const view = new DataView(blob.buffer, blob.byteOffset, blob.byteLength);
  return Array.from({ length: blob.byteLength / 4 }, (_, i) =>
    view.getInt32(i * 4, true)
  );
}

/** The street-level address of a reverse-geocoded location (an NSKeyedArchiver archive of a postal address). */
function addressOf(blob: Uint8Array) {
  const archive = readBplist(blob) as { $objects: Plist[]; $top: Plist };
  const deref = (v: Plist | undefined): Plist | undefined =>
    v && typeof v === "object" && "uid" in v
      ? archive.$objects[(v as Uid).uid]
      : v;
  const top = deref((archive.$top as { root: Plist }).root) as {
    postalAddress?: Plist;
  };
  const postal = deref(top.postalAddress) as Record<string, Plist> | undefined;
  return (["_street", "_subLocality", "_city", "_country"] as const)
    .map((k) => deref(postal?.[k]))
    .filter((v): v is string => typeof v === "string" && v !== "$null")
    .map((v) => v.replaceAll("\n", ", "))
    .join(", ");
}

/**
 * What Apple's search index holds about photos by uuid: each one's scene labels and the words found in it.
 * (The lexicon is read for the ids the photos carry only.)
 */
function analysisOf(library: string, uuids: string[]) {
  const index = join(library, SEARCH_INDEX);
  // A fresh library has no index yet: its photos have no scenes or words, and are still read.
  if (!existsSync(index)) {
    return new Map<string, Analysis>();
  }
  const db = openReadOnly(index);
  try {
    const items = db
      .query<{ ids: Uint8Array; uuid: string }, [string]>(
        "select identifier as uuid, lexeme_ids as ids from items where identifier in (select value from json_each(?))"
      )
      .all(JSON.stringify(uuids))
      .map((i) => ({ ids: lexemesOf(i.ids), uuid: i.uuid }));
    const words = new Map(
      db
        .query<{ category: number; content: string; id: number }, [string]>(
          `select lexeme_id as id, category, content from lexicon where category in (${SCENE}, ${OCR}) and lexeme_id in (select value from json_each(?))`
        )
        .all(JSON.stringify(items.flatMap((i) => i.ids)))
        .map((w) => [w.id, w])
    );
    return new Map(
      items.map(({ ids, uuid }) => {
        const found = ids.flatMap((id) => words.get(id) ?? []);
        const of = (category: number) =>
          found.filter((w) => w.category === category).map((w) => w.content);
        return [uuid, { ocr: of(OCR), scenes: [...new Set(of(SCENE))] }];
      })
    );
  } finally {
    db.close();
  }
}

/**
 * Each person Photos names, as the faces point at them: a person merged into another is the other, the owner is left out,
 * and when Photos links a Contacts card (`ZPERSONURI`) the card's first phone or email.
 */
function namedPersons(rows: PersonRow[], contacts: Contact[]) {
  const byId = new Map(rows.map((p) => [p.id, p]));
  const handles = new Map(contacts.map((c) => [c.id, c.handles[0]]));
  const named = new Map<number, Person>();
  for (const { id } of rows) {
    let p = byId.get(id);
    // A merge never loops; the bound is only so that a store that does cannot hang a read.
    for (const _ of byId.keys()) {
      if (!p?.merged) {
        break;
      }
      p = byId.get(p.merged);
    }
    const handle = p?.uri ? handles.get(p.uri) : undefined;
    if (p?.name && p.confidence < OWNER_CONFIDENCE) {
      named.set(id, {
        id: p.id,
        who: { name: p.name, ...(handle ? { handle } : {}) },
      });
    }
  }
  return named;
}

type Named = Photo["pictured"][number];
/** A named person: the one it is after merges (`id`), and as shown. */
interface Person {
  id: number;
  who: Named;
}

/** The words found in photos as shown: the first that fit `OCR_MAX` characters. */
export const ocrText = (words: string[]) =>
  within(words, OCR_MAX, (w) => w.length + 1).join(" ");

const WORDS = /[\s,]+/;

/** The address of a photo when it says more than its place: not when the place holds it, or all its words. */
export function addressBeyond({
  address,
  place,
}: Pick<Photo, "address" | "place">) {
  const known = place?.toLowerCase() ?? "";
  return address
    ?.split(WORDS)
    .some((w) => w && !known.includes(w.toLowerCase()))
    ? address
    : undefined;
}
interface Analysis {
  ocr: string[];
  scenes: string[];
}

/** A photo as an event: its facts as `Photo` (`records/source.ts`), and its own line for whoever reads it alone. */
function eventOf(
  r: Row,
  analysis: Analysis | undefined,
  faces: { person: number }[],
  persons: Map<number, Person>
): SourceEvent {
  const { ocr = [], scenes = [] } = analysis ?? {};
  const pictured = [
    ...new Map(
      faces.flatMap((f) => {
        const p = persons.get(f.person);
        return p ? [[p.id, p.who] as const] : [];
      })
    ).values(),
  ];
  const photo: Photo = {
    ...(r.address ? { address: addressOf(r.address) } : {}),
    ...(r.caption ? { caption: r.caption } : {}),
    ...(r.favorite ? { favorite: true } : {}),
    ...(ocr.length > 0 ? { ocr } : {}),
    ...(r.offset === null ? {} : { offset: r.offset }),
    pictured,
    ...(r.place ? { place: r.place } : {}),
    ...(r.lat !== NO_COORDINATE && r.lon !== NO_COORDINATE
      ? { point: { lat: r.lat, lon: r.lon } }
      : {}),
    scenes,
    ...(r.kind === VIDEO ? { video: true } : {}),
    ...(r.zone ? { zone: r.zone } : {}),
  };
  return {
    at: fromAppleS(r.date).toISOString(),
    chat: "photos",
    chatName: "Photos",
    fromMe: true,
    id: `photos:${r.uuid}`,
    photo,
    sender: "me",
    source: "photos",
    text: [
      photo.video ? "video" : "photo",
      photo.place,
      addressBeyond(photo),
      scenes.join(", "),
      pictured.length > 0 && `with ${pictured.map((p) => p.name).join(", ")}`,
      photo.caption && `"${photo.caption}"`,
      photo.ocr && `text: ${ocrText(photo.ocr)}`,
    ]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * The photos and videos taken from `since` on (before `before`), oldest first, one event each: its place (the moment's
 * title), address, coordinates, scenes, the words found in it, who Apple's People names in it, his caption, and the
 * zone it was taken in. Not trashed, hidden or burst frames he left out, nor screenshots.
 */
export function readPhotos(
  since: Date,
  before?: Date,
  library = LIBRARY,
  contacts: Contact[] = readContactRecords()
): SourceEvent[] {
  const from = toAppleS(since.getTime());
  const to = before ? toAppleS(before.getTime()) : null;
  const db = openReadOnly(join(library, STORE));
  try {
    const rows = db
      .query<Row, [number, number | null, number | null]>(
        `select a.Z_PK as pk, a.ZUUID as uuid, a.ZDATECREATED as date, a.ZKIND as kind, a.ZFAVORITE as favorite,
                a.ZLATITUDE as lat, a.ZLONGITUDE as lon, m.ZTITLE as place,
                x.ZTIMEZONENAME as zone, x.ZTIMEZONEOFFSET as offset, x.ZREVERSELOCATIONDATA as address,
                coalesce(d.ZLONGDESCRIPTION, x.ZTITLE) as caption
           from ZASSET a
           left join ZADDITIONALASSETATTRIBUTES x on x.ZASSET = a.Z_PK
           left join ZASSETDESCRIPTION d on d.ZASSETATTRIBUTES = x.Z_PK
           left join ZMOMENT m on m.Z_PK = a.ZMOMENT
          where ${WINDOW} and ${SHOWN}
          order by a.ZDATECREATED`
      )
      .all(from, to, to);
    const faces = Map.groupBy(
      db
        .query<
          { asset: number; person: number },
          [number, number | null, number | null]
        >(
          `select f.ZASSETFORFACE as asset, f.ZPERSONFORFACE as person
             from ZDETECTEDFACE f join ZASSET a on a.Z_PK = f.ZASSETFORFACE
            where f.ZPERSONFORFACE is not null and ${WINDOW} and ${SHOWN}`
        )
        .all(from, to, to),
      (f) => f.asset
    );
    const persons = namedPersons(
      db
        .query<PersonRow, []>(
          `select Z_PK as id, ZMERGETARGETPERSON as merged, coalesce(nullif(ZFULLNAME, ''), nullif(ZDISPLAYNAME, '')) as name,
                  ZPERSONURI as uri, ZISMECONFIDENCE as confidence from ZPERSON`
        )
        .all(),
      contacts
    );
    const analysis = analysisOf(
      library,
      rows.map((r) => r.uuid)
    );
    return rows.map((r) =>
      eventOf(r, analysis.get(r.uuid), faces.get(r.pk) ?? [], persons)
    );
  } finally {
    db.close();
  }
}

/** The first photo's time, without reading anything else. */
export function earliestPhoto(library = LIBRARY) {
  return edge("min", library);
}

function edge(which: "max" | "min", library: string) {
  const db = openReadOnly(join(library, STORE));
  try {
    const at = db
      .query<{ at: number | null }, []>(
        `select ${which}(a.ZDATECREATED) as at from ZASSET a where ${SHOWN}`
      )
      .get()?.at;
    return at === null || at === undefined
      ? null
      : iso(fromAppleS(at).getTime());
  } finally {
    db.close();
  }
}

/** The newest photo in Photos (the status snapshot): no words, a caption is his and stays in the library. */
export const newestPhoto = (library = LIBRARY): Newest => ({
  at: edge("max", library),
});
