import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "../core/clock";
import { APP_DATA } from "../core/platform";
import { setSettings, settings } from "../core/settings";
import { openReadOnly } from "../core/sqlite";
import { ARCHIVE, archiveDb, insertAll, phoneMap } from "../sources/archived";
import { openBridged } from "../sources/bridged";

// The archive's half of `beeper-to-networks-2026-10-30` (host/migrate.ts): Beeper's copied messages become rows of each
// network's own archive. `beeper.sqlite` is only read, never written or removed (AGENTS.md: the archive). It goes with
// the migration once it ran on his data.

/** Beeper Desktop's folder: its cached media and Telegram's bridge, read once here. */
const BEEPER = join(APP_DATA, "BeeperTexts");
const NETWORKS = ["line", "instagram", "telegram"];
// Beeper caches mxc://<host>/<id> at media/<host>/<id>, localmxc://<bridge>/<id> at media/localhost<bridge>/<id>.
const MXC = /^(local)?mxc:\/\/([^?]+)/;

interface Attachment {
  fileName?: string;
  id: string;
  isVoiceNote?: boolean;
  mimeType?: string;
  srcURL?: string;
}

interface BeeperRow {
  at: string;
  chat: string;
  chatName: string | null;
  deleted: number;
  eventId: string;
  fromMe: number;
  id: number;
  seenAt: string;
  sender: string | null;
  senderName: string | null;
  text: string;
  type: string;
}

const beeperDb = (archive: string) => archiveDb("beeper", archive);

// Beeper's account ids: `local-<network>_<id>` (a bridge on the Mac), `<network>.<id>` (on its servers) or `<network>`.
const ACCOUNT =
  /^(?:local-)?(whatsapp|imessage|line|instagram|telegram)(?:[._]|$)/;

/**
 * Which network each of Beeper's chats and files was: what the memory's rename needs. From Beeper's archive, then from
 * Beeper's own index (`index.db`: every chat it ever had, its account naming the network: the WhatsApp and iMessage
 * chats it bridged before Life read those apps itself). Empty with neither.
 */
export function beeperNetworks(archive = ARCHIVE, beeper = BEEPER) {
  const chats = new Map<string, string>();
  const files = new Map<string, string>();
  const index = join(beeper, "index.db");
  if (existsSync(index)) {
    const db = openReadOnly(index);
    try {
      for (const t of db
        .query<{ account: string; chat: string }, []>(
          "select threadID as chat, accountID as account from threads"
        )
        .all()) {
        const net = ACCOUNT.exec(t.account)?.[1];
        if (net) {
          chats.set(t.chat, net);
        }
      }
    } finally {
      db.close();
    }
  }
  if (!existsSync(beeperDb(archive))) {
    return { chats, files };
  }
  const db = openReadOnly(beeperDb(archive));
  try {
    for (const r of db
      .query<{ chat: string; network: string }, []>(
        "select distinct chat, network from messages"
      )
      .all()) {
      chats.set(r.chat, r.network);
    }
    for (const r of db
      .query<{ chat: string; files: string }, []>(
        "select chat, files from files"
      )
      .all()) {
      const net = chats.get(r.chat);
      for (const a of JSON.parse(r.files) as Attachment[]) {
        if (net) {
          files.set(a.id, net);
        }
      }
    }
  } finally {
    db.close();
  }
  return { chats, files };
}

/** An attachment Beeper cached, copied into the archive's media (a clone where the disk can): its new path, if any. */
function keepMedia(
  a: Attachment,
  network: string,
  archive: string,
  beeper: string
) {
  const m = (a.srcURL ?? a.id).match(MXC);
  if (!m) {
    return;
  }
  const rel = `${m[1] ? "localhost" : ""}${m[2]}`;
  const from = join(beeper, "media", rel);
  const to = join(archive, "media", network, rel);
  if (!existsSync(from)) {
    return;
  }
  if (!existsSync(to)) {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
  }
  return to;
}

/**
 * Adds Beeper's messages to each network's archive, once and again safely (`insert or ignore`): only those Beeper saw
 * before Life's own copy of that network began (its `cutover`, set here once), each keeping when Beeper saw it
 * (`seenAt`: an old message wakes no one). Telegram senders become their phones (Beeper's Telegram bridge knows them,
 * and goes with Beeper). Its cached media is copied. Returns the rows added.
 */
export function importBeeper(archive = ARCHIVE, beeper = BEEPER) {
  if (!existsSync(beeperDb(archive))) {
    return 0;
  }
  const src = openReadOnly(beeperDb(archive));
  let added = 0;
  try {
    for (const network of NETWORKS) {
      const rows = src
        .query<BeeperRow, [string]>(
          `select id, eventId, chat, chatName, sender, senderName, fromMe, at, type, text, deleted, seenAt
             from messages where network = ? order by rowid`
        )
        .all(network);
      if (rows.length === 0) {
        continue;
      }
      const megabridge = join(beeper, "local-telegram", "megabridge.db");
      if (network === "telegram" && !existsSync(megabridge)) {
        throw new Error(
          "Telegram's senders need Beeper's Telegram bridge (megabridge.db): keep Beeper until this runs"
        );
      }
      const phones =
        network === "telegram"
          ? phoneMap(
              megabridge,
              `select distinct m.sender_mxid as key, i.value as phone from message m
                 join ghost g on g.bridge_id = m.bridge_id and g.id = m.sender_id, json_each(g.identifiers) i
                where i.value like 'tel:%'`
            )
          : new Map<string, string>();
      const db = openBridged(network, archive);
      try {
        const cut = db
          .query<{ at: string | null }, []>("select min(at) as at from cutover")
          .get()?.at;
        const own = db
          .query<{ at: string | null }, []>(
            "select min(seenAt) as at from messages"
          )
          .get()?.at;
        // Its own copy began at its first row, or now for one with no bridge yet (Telegram): a bridge linked later
        // backfills a time Beeper's history already covers.
        const before = cut ?? own ?? clock().toISOString();
        if (!cut) {
          db.run("insert into cutover values (?)", [before]);
        }
        const kept = rows.filter((r) => r.seenAt < before);
        const events = new Set(kept.map((r) => `${r.chat} ${r.eventId}`));
        const files = src
          .query<{ chat: string; eventId: string; files: string }, []>(
            "select chat, eventId, files from files"
          )
          .all()
          .filter((f) => events.has(`${f.chat} ${f.eventId}`))
          .map((f) => [
            f.chat,
            f.eventId,
            JSON.stringify(
              (JSON.parse(f.files) as Attachment[]).map((a) => ({
                fileName: a.fileName,
                id: a.id,
                mimeType: a.isVoiceNote ? "audio/mp4" : a.mimeType,
                path: keepMedia(a, network, archive, beeper),
              }))
            ),
          ]);
        added +=
          insertAll(
            db,
            "insert or ignore into files (chat, eventId, files) values (?, ?, ?)",
            files
          ) +
          insertAll(
            db,
            `insert or ignore into messages (id, eventId, chat, chatName, sender, senderName, fromMe, at, type, text, deleted, seenAt)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            kept.map((r) => [
              ...[r.id, r.eventId, r.chat, r.chatName],
              r.sender && (phones.get(r.sender) ?? r.sender),
              ...[
                r.senderName,
                r.fromMe,
                r.at,
                r.type,
                r.text,
                r.deleted,
                r.seenAt,
              ],
            ])
          );
      } finally {
        db.close();
      }
    }
  } finally {
    src.close();
  }
  return added;
}

/** His `sources` without `beeper`: what it read is each network's now. */
export function dropBeeperSource() {
  const { sources } = settings();
  if ((sources as string[]).includes("beeper")) {
    setSettings({ sources: sources.filter((s) => s !== "beeper") });
  }
}
