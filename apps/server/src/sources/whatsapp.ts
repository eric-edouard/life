import { Database } from "bun:sqlite";
import { constants, copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "../core/clock";
import { HOME } from "../core/platform";
import { type SourceEvent, sourceFile } from "../schema";
import {
  ARCHIVE,
  insertAll,
  newestArchived,
  openArchive,
  phoneMap,
  type Row,
  readArchived,
} from "./archived";
import { fromAppleS, toAppleS } from "./imessage";

// The Mac app's own store, opened read-only by its copy into the archive.
export const WHATSAPP = join(
  HOME,
  "Library/Group Containers/group.net.whatsapp.WhatsApp.shared"
);

// WhatsApp from Life's own archive.

// Type 6 is a group event (JSON, ids), 7 a link (its media is the preview), 8 a document (its text is the file name),
// 14 the "deleted" placeholder. Channels and status posts are not conversations.
// A message is deleted when a placeholder shares its chat, time and author (the archive's `deleted` view, read here from
// the placeholders once: going through the view for each message took 1.3 s for 90 days, this 10 ms).
// Of a message's versions, the latest with a text or a file, else the latest.
const SQL = `with gone as materialized (select chat, at, fromMe from messages where type = 14)
  select m.id, m.chat, m.chatName, m.sender, m.fromMe, m.at, m.type,
    iif(m.type = 8, '', m.text) as text, iif(m.type = 8, m.text, '') as name, iif(m.type = 7, '', m.media) as media,
    exists (select 1 from gone g where g.chat is m.chat and g.at = m.at and g.fromMe = m.fromMe) as deleted
  from messages m
  where m.at >= ? and m.type not in (6, 14)
    and m.chat not like '%@newsletter' and m.chat not like '%@broadcast'
    and m.seenAt = (select x.seenAt from messages x
      where x.chat is m.chat and x.id = m.id and x.type not in (6, 14)
      order by x.text <> '' or x.media <> '' desc, x.seenAt desc limit 1)`;

/** What WhatsApp sends a photo, video, voice note and GIF as: their type even when the file was never downloaded. */
const SENT_AS: Record<number, string> = {
  1: "image/jpeg",
  2: "video/mp4",
  3: "audio/ogg",
  11: "video/mp4",
};

/** WhatsApp senders are `<lid>@lid` now; the address book knows the phone behind each. */
const phonesOfLids = (dir: string) =>
  phoneMap(
    join(dir, "ContactsV2.sqlite"),
    "select ZLID as key, ZPHONENUMBER as phone from ZWAADDRESSBOOKCONTACT where ZLID <> '' and ZPHONENUMBER <> ''"
  );

/** Whether a chat is a group: a group's id is `…@g.us`. */
export const isWhatsappGroup = (chat: string) => chat.endsWith("@g.us");
/**
 * The phone a `<number>@s.whatsapp.net` id holds (a 1:1 chat's key too); none in a group's id or a `@lid`.
 * ponytail: a `@lid` 1:1 chat has no handle in its key (nor has Beeper's), so its older facts keep their author.
 */
export const phoneOf = (jid: string) =>
  jid.endsWith("@s.whatsapp.net") ? `+${jid.split("@")[0]}` : undefined;

/** Messages since `since` as events, oldest first. The sender is `+<phone>` when known, else the WhatsApp id. */
export function readWhatsapp(
  since: Date,
  archive = ARCHIVE,
  whatsapp = WHATSAPP
): SourceEvent[] {
  const phones = phonesOfLids(whatsapp);
  return readArchived<Row & { media: string; name: string; type: number }>(
    "whatsapp",
    SQL,
    since,
    archive,
    (jid) => phones.get(jid) ?? phoneOf(jid) ?? jid,
    // The archive keeps a copy of each file under media/.
    (r) => ({
      files:
        r.media || r.name || SENT_AS[r.type]
          ? [
              sourceFile({
                mime: r.media ? Bun.file(r.media).type : SENT_AS[r.type],
                name: r.name,
                path: r.media && join(archive, "media", r.media),
                ref: `whatsapp:${r.chat}/${r.id}`,
              }),
            ]
          : [],
    })
  );
}

/** The newest message the archive holds, and when it last copied one (the status plate). */
export const newestWhatsapp = () =>
  newestArchived(
    "whatsapp",
    `select at,
       coalesce(chatName, '?') || coalesce(' · ' || senderName, '') || ': ' || text as words
     from messages order by at desc limit 1`
  );

// WhatsApp lets senders delete for everyone for about 60 hours; edits and late media downloads fit in a week too.
const WINDOW_S = 7 * 86_400;

interface StoreRow {
  at: number;
  chat: string | null;
  chatName: string | null;
  fromMe: number;
  id: string;
  media: string;
  sender: string | null;
  senderName: string | null;
  text: string;
  type: number;
}

// One row per version a message was seen in: the original, each edit, and the "deleted" placeholder (type 14).
// A delete for everyone removes the original and adds a type-14 row with a new id but the original's time and sender.
const open = (dir: string) =>
  openArchive(
    dir,
    "whatsapp",
    `create table if not exists messages (
    id text not null, chat text, chatName text, sender text, senderName text, fromMe integer,
    at text not null, type integer not null, text text not null, media text not null, seenAt text not null,
    unique (chat, id, type, text, media));
  drop view if exists deleted;
  create view deleted as
    select m.*, d.seenAt as deletedSeenAt from messages m
      join messages d on d.chat is m.chat and d.at = m.at and d.fromMe = m.fromMe and d.type = 14
     where m.type <> 14 and (m.text <> '' or m.media <> '')`
  );

/** Copies new and changed messages (and their media) into the archive. Returns how many versions were new. */
export function copyWhatsapp(
  source = WHATSAPP,
  dir = ARCHIVE,
  now = clock().getTime()
): number {
  const archive = open(dir);
  const whatsapp = new Database(join(source, "ChatStorage.sqlite"), {
    readonly: true,
  });
  try {
    const empty = !archive.query("select 1 from messages limit 1").get();
    // The first run copies all history; later runs only the last week, where anything can still change.
    const since = empty ? 0 : toAppleS(now) - WINDOW_S;
    const rows = whatsapp
      .query<StoreRow, [number]>(
        `select coalesce(m.ZSTANZAID, 'pk:' || m.Z_PK) as id, m.ZMESSAGETYPE as type, m.ZISFROMME as fromMe,
                m.ZMESSAGEDATE as at, coalesce(m.ZTEXT, '') as text, coalesce(i.ZMEDIALOCALPATH, '') as media,
                s.ZCONTACTJID as chat, s.ZPARTNERNAME as chatName,
                coalesce(g.ZMEMBERJID, m.ZFROMJID) as sender, g.ZCONTACTNAME as senderName
           from ZWAMESSAGE m
           left join ZWACHATSESSION s on s.Z_PK = m.ZCHATSESSION
           left join ZWAMEDIAITEM i on i.Z_PK = m.ZMEDIAITEM
           left join ZWAGROUPMEMBER g on g.Z_PK = m.ZGROUPMEMBER
          where m.ZMESSAGEDATE > ?`
      )
      .all(since);
    const seenAt = new Date(now).toISOString();
    const added = insertAll(
      archive,
      `insert or ignore into messages (id, chat, chatName, sender, senderName, fromMe, at, type, text, media, seenAt)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows.map((r) => [
        ...[r.id, r.chat, r.chatName, r.sender, r.senderName, r.fromMe],
        fromAppleS(r.at).toISOString(),
        ...[r.type, r.text, r.media, seenAt],
      ])
    );
    for (const { media } of rows) {
      const from = join(source, "Message", media);
      const to = join(dir, "media", media);
      if (media && !existsSync(to) && existsSync(from)) {
        mkdirSync(dirname(to), { recursive: true });
        // An APFS clone: no extra disk until WhatsApp deletes its copy.
        copyFileSync(from, to, constants.COPYFILE_FICLONE);
      }
    }
    return added;
  } finally {
    whatsapp.close();
    archive.close();
  }
}
