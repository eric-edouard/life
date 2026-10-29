import { existsSync } from "node:fs";
import { join } from "node:path";
import { clock, HOUR } from "../core/clock";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent } from "../records/source";
import {
  ARCHIVE,
  insertAll,
  LATEST_VERSIONS,
  matrixArchive,
  newestArchived,
  openArchive,
  type Row,
  readArchived,
} from "./archived";
import { type Descriptor, sourceFile } from "./contract";
import { BRIDGES, bridgeSend, configOf, OWNER } from "./matrix";

// A network bridged on his local homeserver (LINE, Instagram: docs/use/bridges.md), read from Life's own archive. The
// homeserver keeps every event, a deleted message's text included (`redaction_retention_period: null`): the buffer the
// archive copies from each pass, so a message deleted before a copy, or while Life is down, is still copied.

const SYNAPSE = join(BRIDGES, "synapse", "homeserver.db");

/** The bridge's archive: the Matrix-shaped versions table, and how far the homeserver's events were copied. */
const openBridged = (name: string, dir: string) =>
  openArchive(
    dir,
    name,
    `${matrixArchive("")};
  create table if not exists copied (stream integer not null)`
  );

interface Event {
  id: string;
  json: string;
  room: string;
  sender: string;
  stream: number;
  ts: number;
  type: string;
}

const EVENTS = `select e.stream_ordering as stream, e.event_id as id, e.room_id as room, e.type, e.sender,
    e.origin_server_ts as ts, j.json
  from events e join event_json j on j.event_id = e.event_id`;

/**
 * A Matrix user id's localpart as a bridge writes it from a network id (mautrix's `EncodeUserLocalpart`): lowercase,
 * digits and `-./` kept, an uppercase letter as `_` and itself lowercased, `_` doubled, anything else `=` and its hex.
 */
const KEPT = /[a-z0-9\-./]/;
const UPPER = /[A-Z]/;
export const localpartOf = (id: string) =>
  [...id]
    .map((c) => {
      if (KEPT.test(c)) {
        return c;
      }
      if (UPPER.test(c)) {
        return `_${c.toLowerCase()}`;
      }
      return c === "_"
        ? "__"
        : [...new TextEncoder().encode(c)]
            .map((b) => `=${b.toString(16).padStart(2, "0")}`)
            .join("");
    })
    .join("");

interface Content {
  body?: string;
  filename?: string;
  info?: { mimetype?: string };
  "m.new_content"?: { body?: string };
  "m.relates_to"?: { event_id?: string; rel_type?: string };
  msgtype?: string;
  name?: string;
  redacts?: string;
  url?: string;
}

/** His side on this bridge: his own account, and the ghosts of his logins (his messages from his phone). */
function hisIds(bridge: string, template: string) {
  const db = openReadOnly(join(BRIDGES, bridge, `${bridge}.db`));
  try {
    const logins = db
      .query<{ id: string }, []>("select id from user_login")
      .all();
    return new Set([
      OWNER,
      ...logins.map(
        (l) => `@${template.replace("{{.}}", localpartOf(l.id))}:life.local`
      ),
    ]);
  } finally {
    db.close();
  }
}

/** A room's name: its own (`m.room.name`), else its other joined members' names, his and the bot's left out. */
function roomNamer(
  hs: ReturnType<typeof openReadOnly>,
  bot: string,
  mine: Set<string>
) {
  const names = new Map<string, string | null>();
  return (room: string) => {
    if (!names.has(room)) {
      const named = hs
        .query<{ json: string }, [string]>(
          `select j.json from current_state_events c join event_json j on j.event_id = c.event_id
            where c.room_id = ? and c.type = 'm.room.name'`
        )
        .get(room);
      const members = hs
        .query<{ name: string | null; user: string }, [string]>(
          "select user_id as user, display_name as name from room_memberships where room_id = ? and membership = 'join'"
        )
        .all(room)
        .filter((m) => m.user !== bot && !mine.has(m.user) && m.name);
      names.set(
        room,
        (named && (JSON.parse(named.json).content as Content).name) ||
          members.map((m) => m.name).join(", ") ||
          null
      );
    }
    return names.get(room) ?? null;
  };
}

/** One event as the archive's rows: its version of a message, and its file; none for what changes no message. */
function archivedVersion(
  e: Event,
  ctx: {
    bot: string;
    find: (id: string) => Event | null;
    mine: Set<string>;
    nameOf: (room: string) => string | null;
    prefix: string;
    seenAt: string;
    senderName: (room: string, user: string) => string | null;
  }
) {
  const version = versionOf(e, ctx.find);
  if (!version || version.original.sender === ctx.bot) {
    return;
  }
  const { original: o, content: c, deleted } = version;
  const handle = o.sender.startsWith(ctx.prefix)
    ? (o.sender.slice(ctx.prefix.length).split(":")[0] ?? o.sender)
    : o.sender;
  const row = [
    ...[o.stream, o.id, o.room, ctx.nameOf(o.room), handle],
    ctx.senderName(o.room, o.sender),
    ctx.mine.has(o.sender) ? 1 : 0,
    new Date(o.ts).toISOString(),
    c.msgtype ?? "m.text",
    deleted ? "" : (c["m.new_content"]?.body ?? c.body ?? ""),
    ...[deleted ? 1 : 0, ctx.seenAt],
  ];
  const file = {
    fileName: c.filename ?? c.body,
    id: c.url,
    mimeType: c.info?.mimetype,
  };
  return {
    files: !deleted && c.url ? [[o.room, o.id, JSON.stringify([file])]] : [],
    row,
  };
}

/**
 * Copies the bridge's new message events from the homeserver into the archive, by its event number (`copied`): a
 * message is its own version, an edit a new version of the original, the redaction of a message a deleted version of
 * it (a redacted edit or reaction changes nothing). Returns how many versions were new. An event that doesn't parse is
 * skipped and logged.
 */
export function copyBridged(
  bridge: string,
  dir = ARCHIVE,
  now = clock().getTime(),
  synapse = SYNAPSE
): number {
  if (!existsSync(synapse)) {
    return 0;
  }
  const { appservice } = configOf(bridge);
  const bot = `@${appservice?.bot?.username}:life.local`;
  const template = appservice?.username_template ?? `${bridge}_{{.}}`;
  const prefix = `@${template.replace("{{.}}", "")}`;
  const mine = hisIds(bridge, template);
  const archive = openBridged(bridge, dir);
  const hs = openReadOnly(synapse);
  try {
    const after =
      archive
        .query<{ n: number | null }, []>("select max(stream) as n from copied")
        .get()?.n ?? 0;
    // ponytail: 5000 events a pass (a first backfill catches up a few passes in); paging by event number keeps it cheap.
    const events = hs
      .query<Event, [number, string]>(
        `${EVENTS} where e.stream_ordering > ? and e.type in ('m.room.message', 'm.room.redaction')
           and e.room_id in (select room_id from room_memberships where user_id = ? and membership = 'join')
         order by e.stream_ordering limit 5000`
      )
      .all(after, bot);
    const byId = hs.query<Event, [string]>(`${EVENTS} where e.event_id = ?`);
    const nameOf = roomNamer(hs, bot, mine);
    const senderName = hs.query<{ name: string | null }, [string, string]>(
      `select display_name as name from room_memberships where room_id = ? and user_id = ?
        order by event_stream_ordering desc limit 1`
    );
    const seenAt = new Date(now).toISOString();
    const rows: (string | number | null)[][] = [];
    const files: string[][] = [];
    const ctx = {
      bot,
      find: (id: string) => byId.get(id),
      mine,
      nameOf,
      prefix,
      seenAt,
      senderName: (room: string, user: string) =>
        senderName.get(room, user)?.name ?? null,
    };
    for (const e of events) {
      try {
        const v = archivedVersion(e, ctx);
        if (v) {
          rows.push(v.row);
          files.push(...v.files);
        }
      } catch (error) {
        console.error(seenAt, bridge, e.id, error);
      }
    }
    const added =
      insertAll(
        archive,
        "insert or ignore into files (chat, eventId, files) values (?, ?, ?)",
        files
      ) +
      insertAll(
        archive,
        `insert or ignore into messages (id, eventId, chat, chatName, sender, senderName, fromMe, at, type, text, deleted, seenAt)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        rows
      );
    const last = events.at(-1)?.stream;
    if (last) {
      archive.run("delete from copied");
      archive.run("insert into copied values (?)", [last]);
    }
    return added;
  } finally {
    hs.close();
    archive.close();
  }
}

/**
 * What one event makes of a message: its original event, the content of this version, and whether it deletes it. A
 * message is itself; an edit (`m.replace`) a version of its original; a redaction deletes the message it removes, and
 * only a message (never an edit or a reaction). None for anything else.
 */
export function versionOf(e: Event, find: (id: string) => Event | null) {
  const content =
    (JSON.parse(e.json) as { content?: Content; redacts?: string }).content ??
    {};
  if (e.type === "m.room.redaction") {
    const target = find(
      (JSON.parse(e.json) as { redacts?: string }).redacts ??
        content.redacts ??
        ""
    );
    const was =
      target &&
      ((JSON.parse(target.json) as { content?: Content }).content ?? {});
    return target?.type === "m.room.message" &&
      was &&
      was["m.relates_to"]?.rel_type !== "m.replace"
      ? { content: was, deleted: true, original: target }
      : undefined;
  }
  const edit = content["m.relates_to"];
  if (edit?.rel_type === "m.replace") {
    const original = find(edit.event_id ?? "");
    return original ? { content, deleted: false, original } : undefined;
  }
  return { content, deleted: false, original: e };
}

/** An `mxc://<server>/<id>` file at the homeserver's own copy (`media_store/local_content/<2>/<2>/<rest>`). */
const MXC = /^mxc:\/\/[^/]+\/(.{2})(.{2})(.+)$/;
const mediaOf = (url: string) => {
  const m = url.match(MXC);
  return m?.[3]
    ? join(
        BRIDGES,
        "synapse",
        "media_store",
        "local_content",
        `${m[1]}`,
        `${m[2]}`,
        m[3]
      )
    : undefined;
};

/** The bridge's messages since `since`, from the archive, oldest first. */
type Bridged = "instagram" | "line";

export const readBridged = (
  bridge: Bridged,
  since: Date,
  archive = ARCHIVE
): SourceEvent[] =>
  readArchived<Row & { files: string | null }>(
    bridge,
    LATEST_VERSIONS,
    since,
    archive,
    (s) => s,
    (r) => ({
      files: (
        JSON.parse(r.files ?? "[]") as {
          fileName?: string;
          id: string;
          mimeType?: string;
        }[]
      ).map((f) =>
        sourceFile({
          mime: f.mimeType,
          name: f.fileName,
          path: mediaOf(f.id),
          ref: `${bridge}:${f.id}`,
        })
      ),
    })
  );

/** A bridged network as a source: its archive's copy, its reading and newest, its send (`bridgeSend`). */
export const bridgedSource = (name: Bridged, label: string): Descriptor => ({
  chatDays: 7,
  kind: "chat",
  label,
  name,
  newest: () =>
    newestArchived(
      name,
      "select at, coalesce(chatName, '?') || ': ' || text as words from messages order by at desc limit 1"
    ),
  read: (since) => readBridged(name, since),
  searchDays: 90,
  send: bridgeSend(name),
  silentAfter: 72 * HOUR,
  store: { copies: "messages", copy: () => copyBridged(name), media: "''" },
});
