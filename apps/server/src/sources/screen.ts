import type { SQLQueryBindings } from "bun:sqlite";
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
} from "node:fs";
import { join } from "node:path";
import { clock, MIN } from "../core/clock";
import { HOME } from "../core/platform";
import { type Field, fieldsOf } from "../core/protobuf";
import { settings } from "../core/settings";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent } from "../records/source";
import {
  ARCHIVE,
  archiveDb,
  insertAll,
  newestArchived,
  openArchive,
} from "./archived";
import type { Newest } from "./contract";
import { fromAppleS } from "./imessage";

// Screen Time as a source: his time in each app and Safari website, on the Mac and on each iOS device that syncs to it,
// as Apple's Biome records them. Biome prunes them after a week or a few, so `copyScreen` keeps every record in the
// archive (`screen.sqlite`), raw; `readScreen` reads them back as stints. Nothing in an app is read, only its name.

const BIOME = join(HOME, "Library/Biome");
/** An app's time (`app`) or a website's (`web`). */
type Stream = "app" | "web";

/** How many records a SEGB file says it holds: its header's second word. */
const countOf = (b: Buffer) => b.readUInt32LE(4);

/**
 * The kept records of a SEGB v2 file (Biome's segment format): a 32-byte header, then records 4-byte aligned (an 8-byte
 * header, then protobuf), and at the end a table of 16-byte entries, the first record's last: where a record ends
 * (counted after the header), its state (1 kept; pruned ones are blanked; 0 not yet written) and its time.
 */
export function parseSegb(bytes: Uint8Array) {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.toString("latin1", 0, 4) !== "SEGB") {
    throw new Error("not a SEGB v2 file");
  }
  const records: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < countOf(b); i += 1) {
    const entry = b.length - 16 * (i + 1);
    const end = b.readUInt32LE(entry);
    const state = b.readUInt32LE(entry + 4);
    if (state === 0) {
      throw new Error("a record is still being written");
    }
    if (state === 1) {
      records.push(b.subarray(32 + start + 8, 32 + end));
    }
    start = Math.ceil(end / 4) * 4;
  }
  return records;
}

const text = (f: Field | undefined) =>
  f instanceof Uint8Array ? new TextDecoder().decode(f) : "";
const num = (f: Field | undefined) => (typeof f === "number" ? f : 0);

/** A record as the archive keeps it: an app or a website starting or stopping. */
export interface ScreenRecord {
  at: string;
  bundle: string;
  /** App.WebUsage only: the website. */
  domain: string;
  starting: number;
  /** App.WebUsage only: one visit's id, the same on its start and its end. */
  visit: string;
}

/** An instant in Apple's seconds since 2001 as milliseconds; 0 for none. */
const appleMs = (s: number) => (s > 0 ? fromAppleS(s).getTime() : 0);

/** A record from its fields, or nothing when it lacks its app or time. */
const recordFrom = (
  at: number,
  bundle: string,
  starting: boolean,
  web?: { domain: string; visit: string }
): ScreenRecord[] =>
  at && bundle
    ? [
        {
          at: new Date(at).toISOString(),
          bundle,
          domain: web?.domain ?? "",
          starting: Number(starting),
          visit: web?.visit ?? "",
        },
      ]
    : [];

/**
 * The Biome streams read, with their fields as macOS 27 and iOS 27 write them. The Mac's app time is Screen Time's own
 * (`ScreenTime.AppUsage`, which leaves idle time out); an iOS device syncs only which app is in front (`App.InFocus`,
 * `remote/<device>`); websites are Safari's on the Mac.
 */
const FEEDS = [
  {
    folder: "ScreenTime.AppUsage/local",
    record: (f: Map<number, Field>) =>
      recordFrom(num(f.get(2)) * 1000, text(f.get(3)), num(f.get(1)) === 1),
    stream: "app",
  },
  {
    folder: "App.InFocus/remote",
    record: (f: Map<number, Field>) =>
      recordFrom(appleMs(num(f.get(4))), text(f.get(6)), num(f.get(3)) === 1),
    stream: "app",
  },
  {
    folder: "App.WebUsage/local",
    record: (f: Map<number, Field>) =>
      recordFrom(appleMs(num(f.get(2))), text(f.get(6)), num(f.get(3)) === 3, {
        domain: text(f.get(5)),
        visit: text(f.get(1)),
      }),
    stream: "web",
  },
] as const satisfies {
  folder: string;
  record: (f: Map<number, Field>) => ScreenRecord[];
  stream: Stream;
}[];
type Feed = (typeof FEEDS)[number];

/** This Mac's device id and each synced device's platform (2 iOS, 3 macOS), from Biome's sync database. */
function readPeers(biome = BIOME) {
  const path = join(biome, "sync/sync.db");
  if (!existsSync(path)) {
    return [];
  }
  const db = openReadOnly(path);
  try {
    return db
      .query<{ id: string; me: number; platform: number | null }, []>(
        "select device_identifier as id, me, platform from DevicePeer"
      )
      .all();
  } finally {
    db.close();
  }
}

const PLATFORMS: Record<number, string> = { 2: "iOS device", 3: "Mac" };
/** What he calls a device (the `devices` setting), else its platform. */
const deviceName = (id: string, peers: ReturnType<typeof readPeers>) =>
  settings().devices?.[id] ??
  PLATFORMS[peers.find((p) => p.id === id)?.platform ?? 0] ??
  "device";

/** Each file of a feed with the device it is from: this Mac's (a `local` folder) or a synced one's (`remote/<id>`). */
function filesOf(biome: string, feed: Feed, mac: string) {
  const root = join(biome, "streams/restricted", feed.folder);
  const files = (dir: string, device: string) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((f) =>
      f.isFile() ? [{ device, feed, path: join(dir, f.name) }] : []
    );
  if (!existsSync(root)) {
    return [];
  }
  return root.endsWith("remote")
    ? readdirSync(root).flatMap((id) => files(join(root, id), id))
    : files(root, mac);
}

const openScreen = (dir: string) =>
  openArchive(
    dir,
    "screen",
    `create table if not exists events (device text not null, stream text not null, at text not null,
      starting integer not null, bundle text not null, domain text not null, visit text not null, seenAt text not null,
      unique (device, stream, at, bundle, domain, starting))`
  );

// A file is parsed again only when its record count moves, once copied; per process, so a restart reads each once more.
// Not its size or time: Biome writes records into a file made at full size, leaving both unchanged.
const seen = new Map<string, number>();

/** A file's record count from its header alone; undefined when it can't be read, so its full read reports why. */
function readHeadCount(path: string) {
  const head = Buffer.alloc(8);
  try {
    const fd = openSync(path, "r");
    try {
      readSync(fd, head, 0, 8, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return;
  }
  return countOf(head);
}

/**
 * Every new kept record of every Biome file into the archive. A record already there is skipped by its key, so one an
 * iPhone syncs late, older than the newest copied, still lands. A file that fails is tried again next pass, after the
 * others are copied. How many were new.
 */
export function copyScreen(biome = BIOME, dir = ARCHIVE) {
  if (!existsSync(join(biome, "sync/sync.db"))) {
    throw new Error("Biome is not readable: Life needs Full Disk Access");
  }
  const mac = readPeers(biome).find((p) => p.me)?.id;
  if (!mac) {
    throw new Error("Biome names no device of this Mac's own");
  }
  const changed = FEEDS.flatMap((feed) => filesOf(biome, feed, mac)).filter(
    (f) => {
      const count = readHeadCount(f.path);
      return count === undefined || seen.get(f.path) !== count;
    }
  );
  if (changed.length === 0) {
    return 0;
  }
  const seenAt = clock().toISOString();
  const failed: string[] = [];
  let copied = 0;
  const archive = openScreen(dir);
  try {
    for (const f of changed) {
      try {
        const bytes = readFileSync(f.path);
        const rows: SQLQueryBindings[][] = parseSegb(bytes).flatMap((r) =>
          f.feed
            .record(fieldsOf(r))
            .map((x) => [
              f.device,
              f.feed.stream,
              x.at,
              x.starting,
              x.bundle,
              x.domain,
              x.visit,
              seenAt,
            ])
        );
        copied += insertAll(
          archive,
          "insert or ignore into events values (?, ?, ?, ?, ?, ?, ?, ?)",
          rows
        );
        seen.set(f.path, countOf(bytes));
      } catch (e) {
        failed.push(`${f.path}: ${(e as Error).message}`);
      }
    }
  } finally {
    archive.close();
  }
  if (failed.length > 0) {
    throw new Error(`Screen Time: ${failed.join("; ")}`);
  }
  return copied;
}

/** An app's time in front, or a website's, from when it came to when it left. */
interface Stint {
  at: string;
  device: string;
  until: string;
  /** The app's bundle id, or `web: <domain>`. */
  what: string;
}

/** How a website's stint is named: `web: <domain>`, beside the apps' bundle ids. */
export const WEB = "web: ";
/** Back within this long, the same app or website is one stint. */
const REJOIN = 2 * MIN;
// What only frames the apps (the lock and home screens, Finder, settings, sign-in prompts) and Life itself: each still
// ends the stint before it. Call screens stay.
const FRAME =
  /^com\.apple\.(?:loginwindow|finder|SecurityAgent|control-center|systempreferences|Preferences|springboard|SpringBoard|SleepLockScreen|LocalAuthentication|UserNotificationCenter|ScreenSaver)|^app\.life\.mac$/;

/**
 * The stints in `records` (one device's, one stream's, in time order): an app's from its coming to the front to its
 * leaving or the next app's coming (an end at the same instant first); a website's by its visit id. Frames left out,
 * and the same app or website back within 2 minutes joined.
 */
export function stintsOf(
  records: (ScreenRecord & { device: string })[],
  stream: Stream
): Stint[] {
  const raw: Stint[] = [];
  const open = new Map<string, ScreenRecord & { device: string }>();
  for (const r of records.toSorted(
    (a, b) => a.at.localeCompare(b.at) || a.starting - b.starting
  )) {
    const key = stream === "app" ? "front" : r.visit;
    const was = open.get(key);
    // An app coming ends the one in front; an end ends only its own app's or visit's stint.
    if (
      was &&
      (r.starting
        ? stream === "app"
        : stream === "web" || was.bundle === r.bundle)
    ) {
      raw.push({
        at: was.at,
        device: r.device,
        until: r.at,
        what: stream === "app" ? was.bundle : `${WEB}${was.domain}`,
      });
      open.delete(key);
    }
    if (r.starting) {
      open.set(key, r);
    }
  }
  return joined(
    raw
      .filter((x) => !FRAME.test(x.what) && x.until > x.at)
      .sort((a, b) => a.at.localeCompare(b.at))
  );
}

/** `stints` in time order, the same app or website back within 2 minutes made one. */
function joined(stints: Stint[]) {
  const kept: Stint[] = [];
  for (const s of stints) {
    const last = kept.findLast((k) => k.what === s.what);
    if (last && Date.parse(s.at) - Date.parse(last.until) < REJOIN) {
      last.until = s.until > last.until ? s.until : last.until;
    } else {
      kept.push({ ...s });
    }
  }
  return kept;
}

/**
 * The stints of every device since `since`, as events: chat the device (its name the `devices` setting's), text the app
 * or website, `until` when it left.
 */
export function readScreen(
  since: Date,
  dir = ARCHIVE,
  biome = BIOME,
  before?: Date
) {
  const path = archiveDb("screen", dir);
  if (!existsSync(path)) {
    return [];
  }
  const db = openReadOnly(path);
  // Join complete stints before bounding their starts: an edge can close or rejoin across either boundary.
  const rows = (() => {
    try {
      return db
        .query<ScreenRecord & { device: string; stream: Stream }, []>(
          "select device, stream, at, starting, bundle, domain, visit from events order by at"
        )
        .all();
    } finally {
      db.close();
    }
  })();
  const peers = readPeers(biome);
  const groups = Map.groupBy(rows, (r) => `${r.device}|${r.stream}`);
  return [...groups.values()]
    .flatMap((g) => stintsOf(g, (g[0] as (typeof g)[number]).stream))
    .filter(
      (s) =>
        s.at >= since.toISOString() && (!before || s.at < before.toISOString())
    )
    .map(
      (s): SourceEvent => ({
        at: s.at,
        chat: s.device,
        chatName: deviceName(s.device, peers),
        fromMe: true,
        id: `screen:${s.device}/${s.what}/${s.at}`,
        sender: "me",
        source: "screen",
        text: s.what,
        until: s.until,
      })
    )
    .sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Each device's newest record (the status snapshot): one part per device he still uses, so a retired one turns
 * nothing amber. A device Biome no longer syncs with is gone; of one platform (iOS, Mac), the one heard from last
 * replaced the others.
 */
// ponytail: two iOS devices in use at once (an iPhone and an iPad) show as one; a setting naming retired devices then.
export function newestScreen(dir = ARCHIVE, biome = BIOME): Newest {
  const peers = readPeers(biome);
  const newest = newestArchived(
    "screen",
    "select max(at) as at, device as label, '' as words from events group by device order by at desc",
    dir
  );
  const platformOf = (id: string) => peers.find((p) => p.id === id)?.platform;
  const current = (newest.parts ?? []).filter(
    (p, i, all) =>
      platformOf(p.label) !== undefined &&
      all.findIndex((q) => platformOf(q.label) === platformOf(p.label)) === i
  );
  return {
    at: newest.at,
    parts: current.map((p) => ({ ...p, label: deviceName(p.label, peers) })),
  };
}
