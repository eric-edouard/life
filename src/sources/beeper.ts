import { join } from "node:path";
import { type SourceEvent, sourceFile } from "../schema";
import {
  ARCHIVE,
  BEEPER,
  newestArchived,
  phoneMap,
  type Row,
  readArchived,
} from "./archived";

// LINE, Telegram and Instagram (the chats Beeper Desktop bridges) from Life's own archive. Beeper's API is not used: it
// only works while Beeper runs and keeps no deleted text.

// Of a message's versions, the latest with a text or not deleted (a photo has no text), with its latest files.
const SQL = `select m.id, m.chat, m.chatName, m.sender, m.fromMe, m.at, m.text, f.files,
    exists (select 1 from deleted d where d.chat = m.chat and d.eventId = m.eventId) as deleted
  from messages m left join files f on f.rowid = (select max(rowid) from files x
    where x.chat = m.chat and x.eventId = m.eventId)
  where m.at >= ?
    and m.rowid = (select max(x.rowid) from messages x
      where x.chat = m.chat and x.eventId = m.eventId and (x.text <> '' or not x.deleted))`;

/** Telegram senders are Matrix ids; the bridge knows the phone behind each. */
const telegramPhones = (beeper: string) =>
  phoneMap(
    join(beeper, "local-telegram/megabridge.db"),
    `select distinct m.sender_mxid as key, i.value as phone from message m
       join ghost g on g.bridge_id = m.bridge_id and g.id = m.sender_id, json_each(g.identifiers) i
      where i.value like 'tel:%'`
  );

// Beeper caches mxc://<host>/<id> at media/<host>/<id>, localmxc://<bridge>/<id> at media/localhost<bridge>/<id>.
const MXC = /^(local)?mxc:\/\/([^?]+)/;

interface Attachment {
  fileName?: string;
  id: string;
  isVoiceNote?: boolean;
  mimeType?: string;
  srcURL?: string;
}

/** A message's attachments as files, at Beeper's cached copy when it fetched one. Beeper types a voice note video/mp4. */
const filesOf = (beeper: string, json: string | null) =>
  (JSON.parse(json ?? "[]") as Attachment[]).map((a) => {
    const m = (a.srcURL ?? a.id).match(MXC);
    return sourceFile({
      mime: a.isVoiceNote ? "audio/mp4" : a.mimeType,
      name: a.fileName,
      path: m && join(beeper, "media", `${m[1] ? "localhost" : ""}${m[2]}`),
      ref: `beeper:${a.id}`,
    });
  });

/** Messages since `since` as events, oldest first. The sender is `+<phone>` when known, else the Matrix id. */
export function readBeeper(
  since: Date,
  archive = ARCHIVE,
  beeper = BEEPER
): SourceEvent[] {
  const phones = telegramPhones(beeper);
  return readArchived<Row & { files: string | null }>(
    "beeper",
    SQL,
    since,
    archive,
    (s) => phones.get(s) ?? s,
    (r) => ({ files: filesOf(beeper, r.files) })
  );
}

/** Each network's newest message the archive holds (the status page). */
export const newestBeeper = () =>
  newestArchived(
    "beeper",
    `select network as label, max(at) as at, max(seenAt) as seen,
       network || ': ' || coalesce(chatName, '?') || ': ' || text as words
     from messages group by network order by at desc`
  );
