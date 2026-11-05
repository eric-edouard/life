import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock, HOUR } from "../core/clock";
import { log } from "../core/log";
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
import { BRIDGES, configOf, OWNER, userOn } from "./matrix";

// A network bridged on his local homeserver (LINE, Instagram: docs/use/bridges.md), read from Life's own archive. The
// homeserver keeps every event, a deleted message's text included (`redaction_retention_period: null`): the buffer the
// archive copies from each pass, so a message deleted before a copy, or while Life is down, is still copied.

const SYNAPSE = join(BRIDGES, "synapse", "homeserver.db");

/**
 * A network's archive: the Matrix-shaped versions table, how far the homeserver's events were copied (`copied`), and
 * when Life's own copy of it began (`cutover`, once): what the bridge backfilled from before it is never read, the
 * history there is the earlier copy's (imported 30 Oct 2026).
 */
export const openBridged = (name: string, dir: string) =>
  openArchive(
    dir,
    name,
    `${matrixArchive("")};
  create table if not exists copied (stream integer not null);
  create table if not exists cutover (at text not null)`
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
      ...logins.map((l) =>
        userOn(template.replace("{{.}}", localpartOf(l.id)))
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
    isChat: (room: string) => boolean;
    find: (id: string) => Event | null;
    mine: Set<string>;
    nameOf: (room: string) => string | null;
    prefix: string;
    seenAt: string;
    senderName: (room: string, user: string) => string | null;
  }
) {
  const version = versionOf(e, ctx.find);
  // The bridge's own room with him (its commands, its notices) is no conversation.
  if (
    !version ||
    version.original.sender === ctx.bot ||
    !ctx.isChat(version.original.room)
  ) {
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
  const bot = userOn(`${appservice?.bot?.username}`);
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
    const newest =
      hs
        .query<{ n: number | null }, []>(
          "select max(stream_ordering) as n from events"
        )
        .get()?.n ?? 0;
    if (after > newest) {
      throw new Error(
        `${bridge}: copied past the homeserver's newest event (${after} > ${newest}): was its database made again?`
      );
    }
    // ponytail: 5000 events a pass (a first backfill catches up a few passes in); paging by event number keeps it cheap.
    const events = hs
      .query<Event, [number, string]>(
        `${EVENTS} where e.stream_ordering > ? and e.type in ('m.room.message', 'm.room.redaction')
           and e.rejection_reason is null and not e.outlier
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
    const others = hs.query<{ n: number }, [string, string, string]>(
      "select count(*) as n from room_memberships where room_id = ? and user_id <> ? and user_id <> ?"
    );
    const ctx = {
      bot,
      find: (id: string) => byId.get(id),
      isChat: (room: string) => (others.get(room, bot, OWNER)?.n ?? 0) > 0,
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
        // Skipped for good: the cursor moves past it, so one event that never parses can't stop the copy.
        log("run.error", {
          error: `${e.id}: ${(error as Error).message}`,
          step: `archive.${bridge}.event`,
        });
      }
    }
    const last = events.at(-1)?.stream;
    // One transaction: the versions and how far they were copied land together.
    const added = archive.transaction(() => {
      const n =
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
      if (last) {
        archive.run("delete from copied");
        archive.run("insert into copied values (?)", [last]);
      }
      return n;
    })();
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
        dirname(SYNAPSE),
        "media_store",
        "local_content",
        `${m[1]}`,
        `${m[2]}`,
        m[3]
      )
    : undefined;
};

/** What a bridge's notice says of a call: it started (its end comes later), it ended, or the whole call. */
interface CallNotice {
  ends?: true;
  seconds?: number;
  video: boolean;
}

const INSTAGRAM_CALL =
  /^(?:(?<missed>You missed)|.+ started) an? (?<kind>audio call|video chat)$|^(?<ended>Audio call|Video chat) ended$/;
// The length's form is the bridge's (`Voice call (5m33s)`, seen Nov 2026); the notice's time is taken as the call's.
const LINE_CALL =
  /^(?<missed>Missed )?(?<kind>[Vv]oice|[Vv]ideo) call(?: \((?:(?<h>\d+)h)?(?:(?<m>\d+)m)?(?<s>\d+)s\))?$/;

const VIDEO = /video/i;

/**
 * Every network on a bridge (`bun life bridge`, docs/use/bridges.md), each a source of its own (`memory/sources.ts`):
 * what he calls it, the bridge's repository and command to build, and how its notices say a call (`callOf`). The one list.
 */
export const NETWORKS = [
  {
    callOf: (text: string): CallNotice | undefined => {
      const g = LINE_CALL.exec(text)?.groups;
      if (!g || (!g.missed && g.s === undefined)) {
        return undefined;
      }
      const seconds = g.missed
        ? 0
        : Number(g.h ?? 0) * 3600 + Number(g.m ?? 0) * 60 + Number(g.s);
      return { seconds, video: VIDEO.test(g.kind ?? "") };
    },
    cmd: "cmd/matrix-line",
    label: "LINE",
    name: "line",
    repo: "beeper/line",
  },
  {
    callOf: (text: string): CallNotice | undefined => {
      const g = INSTAGRAM_CALL.exec(text)?.groups;
      if (!g) {
        return undefined;
      }
      const video = VIDEO.test(g.kind ?? g.ended ?? "");
      if (g.ended) {
        return { ends: true, video };
      }
      return g.missed ? { seconds: 0, video } : { video };
    },
    cmd: "cmd/mautrix-instagram",
    label: "Instagram",
    name: "instagram",
    repo: "mautrix/meta",
  },
  {
    cmd: "cmd/mautrix-telegram",
    label: "Telegram",
    name: "telegram",
    repo: "mautrix/telegram",
  },
  {
    cmd: "cmd/mautrix-linkedin",
    label: "LinkedIn",
    name: "linkedin",
    repo: "mautrix/linkedin",
  },
] as const;
// The literal entries keep their names typed; a network with no calls has no `callOf`.
export type Network = (typeof NETWORKS)[number] & {
  callOf?: (text: string) => CallNotice | undefined;
};
/**
 * A network's calls as messages of their chats: a call's notice becomes a phone call, a start taking its outcome from
 * the chat's next end (its length) or missed notice (Instagram's "You missed" follows its start), which goes; a start
 * with neither has no length. Each keyed by chat and time (`keyOf`): the notice's kind is its row's, not the event's.
 */
function withCalls(events: SourceEvent[], notices: Map<string, CallNotice>) {
  type Call = NonNullable<SourceEvent["phoneCall"]>;
  const open = new Map<string, { call: Call; from: number }>();
  return events.flatMap((e) => {
    const c = notices.get(keyOf(e));
    if (!c) {
      return [e];
    }
    const started = open.get(e.chat);
    open.delete(e.chat);
    if (started && (c.ends || c.seconds === 0)) {
      started.call.seconds = c.ends
        ? Math.max(0, Math.round((Date.parse(e.at) - started.from) / 1000))
        : 0;
      return [];
    }
    if (c.ends) {
      return [];
    }
    const phoneCall: Call =
      c.seconds === undefined
        ? { video: c.video }
        : { seconds: c.seconds, video: c.video };
    if (c.seconds === undefined) {
      open.set(e.chat, { call: phoneCall, from: Date.parse(e.at) });
    }
    return [{ ...e, phoneCall }];
  });
}
const keyOf = (r: { at: string; chat: string }) => `${r.chat} ${r.at}`;

/**
 * Of the archive's versions, the latest ones but for what the bridge backfilled from before its cutover (written after
 * it, about a time before it): that time is the earlier copy's.
 */
const SINCE_CUTOVER = `${LATEST_VERSIONS}
    and not (m.at < coalesce((select min(at) from cutover), '') and m.seenAt >= coalesce((select min(at) from cutover), ''))`;

/** The network's messages since `since`, from its archive, oldest first (`SINCE_CUTOVER`), its calls as phone calls. */
export function readBridged(
  { callOf, name: bridge }: Network,
  since: Date,
  archive = ARCHIVE
): SourceEvent[] {
  const notices = new Map<string, CallNotice>();
  const events = readArchived<Row & { files: string | null; type: string }>(
    bridge,
    SINCE_CUTOVER,
    since,
    archive,
    (s) => s,
    (r) => {
      const call = r.type.toLowerCase().includes("notice")
        ? callOf?.(r.text)
        : undefined;
      if (call) {
        notices.set(keyOf(r), call);
      }
      return {
        files: (
          JSON.parse(r.files ?? "[]") as {
            fileName?: string;
            id: string;
            mimeType?: string;
            path?: string;
          }[]
        ).map((f) =>
          sourceFile({
            mime: f.mimeType,
            name: f.fileName,
            // An imported file has its copy's path; the bridge's are in the homeserver's media.
            path: f.path ?? mediaOf(f.id),
            ref: `${bridge}:${f.id}`,
          })
        ),
      };
    }
  );
  return notices.size ? withCalls(events, notices) : events;
}

/** A bridged network as a source: its archive's copy, its reading and newest. */
export const bridgedSource = (network: Network): Descriptor => {
  const { label, name } = network;
  return {
    chatDays: 7,
    kind: "chat",
    label,
    name,
    newest: () =>
      newestArchived(
        name,
        "select at, coalesce(chatName, '?') || ': ' || text as words from messages order by at desc limit 1"
      ),
    read: (since) => readBridged(network, since),
    searchDays: 90,
    silentAfter: 72 * HOUR,
    store: { copies: "messages", copy: () => copyBridged(name), deleted: {} },
  };
};
