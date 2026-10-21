import { join } from "node:path";
import { type SourceEvent, sourceFile } from "../schema";
import {
  ARCHIVE,
  phoneMap,
  type Row,
  readArchived,
  WHATSAPP,
} from "./archived";

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
