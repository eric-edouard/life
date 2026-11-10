import { join } from "node:path";
import { z } from "zod";
import { clock } from "../core/clock";
import { APP_DATA } from "../core/platform";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent } from "../records/source";
import {
  ARCHIVE,
  archiveDb,
  insertAll,
  newestArchived,
  openArchive,
} from "./archived";
import { handleKey, readContacts } from "./contacts";
import { fromAppleS } from "./imessage";

export const PHONE = join(APP_DATA, "CallHistoryDB/CallHistory.storedata");

const Call = z
  .object({
    address: z.string().nullable(),
    answered: z.number().nullable(),
    at: z.number(),
    duration: z.number().nonnegative().nullable(),
    fromMe: z.number(),
    id: z.string().min(1),
    participants: z.array(z.string()),
    provider: z.enum(["com.apple.Telephony", "com.apple.FaceTime"]),
    type: z.number(),
  })
  .strict();

/** Copies every call still present, including updates and late syncs; Apple's deletions never delete a copy. */
export function copyPhone(source = PHONE, dir = ARCHIVE, now = clock()) {
  const db = openReadOnly(source);
  try {
    const rows = db
      .query<
        Omit<z.infer<typeof Call>, "participants"> & { participants: string },
        []
      >(`
      select c.ZUNIQUE_ID as id, c.ZDATE as at, c.ZADDRESS as address,
        c.ZORIGINATED as fromMe, c.ZANSWERED as answered, c.ZDURATION as duration,
        c.ZCALLTYPE as type, c.ZSERVICE_PROVIDER as provider,
        (select json_group_array(value) from (
          select distinct h.ZVALUE as value from Z_2REMOTEPARTICIPANTHANDLES p
          join ZHANDLE h on h.Z_PK = p.Z_4REMOTEPARTICIPANTHANDLES
          where p.Z_2REMOTEPARTICIPANTCALLS = c.Z_PK and h.ZVALUE <> '' order by h.ZVALUE
        )) as participants
      from ZCALLRECORD c where c.ZSERVICE_PROVIDER in (${Call.shape.provider.options.map((provider) => `'${provider}'`).join(", ")})
    `)
      .all()
      .map((r) =>
        Call.parse({ ...r, participants: JSON.parse(r.participants) })
      );
    const archive = openArchive(
      dir,
      "phone",
      `create table if not exists calls (
      id text not null, at text not null, payload text not null, seenAt text not null);
      create index if not exists calls_id on calls (id)`
    );
    try {
      return insertAll(
        archive,
        `insert into calls (id, at, payload, seenAt) select ?, ?, ?, ?
         where ? is not (select payload from calls where id = ? order by rowid desc limit 1)`,
        rows.map((r) => [
          r.id,
          fromAppleS(r.at).toISOString(),
          JSON.stringify(r),
          now.toISOString(),
          JSON.stringify(r),
          r.id,
        ])
      );
    } finally {
      archive.close();
    }
  } finally {
    db.close();
  }
}

/** Explicit remote participant sets name groups; a group UUID alone says nothing about who joined. */
export const isPhoneGroup = (chat: string) => chat.startsWith("group:");

// Positive duration proves connection even when an outgoing call's answered flag is unset.
function secondsOf(c: z.infer<typeof Call>) {
  if (c.duration === null) {
    return;
  }
  if (c.duration > 0) {
    return Math.max(1, Math.round(c.duration));
  }
  return c.answered === 0 ? 0 : undefined;
}

/** Call-only chats, read from the latest archived version, with raw handles for the existing people resolver. */
export function readPhone(
  since: Date,
  dir = ARCHIVE,
  contacts = readContacts()
): SourceEvent[] {
  const db = openReadOnly(archiveDb("phone", dir));
  try {
    return db
      .query<{ at: string; payload: string }, [string]>(`
      select at, payload from calls c where at >= ?
      and rowid = (select max(rowid) from calls x where x.id = c.id) order by at, id
    `)
      .all(since.toISOString())
      .map((r) => {
        const c = Call.parse(JSON.parse(r.payload));
        const handles = c.participants.length
          ? c.participants
          : [c.address].filter((h): h is string => Boolean(h));
        const chat =
          handles.length > 1
            ? `group:${JSON.stringify(handles)}`
            : handles[0] || `unknown:${c.id}`;
        const seconds = secondsOf(c);
        return {
          at: r.at,
          chat,
          chatName:
            handles.map((h) => contacts.get(handleKey(h)) ?? h).join(", ") ||
            undefined,
          fromMe: c.fromMe === 1,
          id: `phone:${chat}/${c.id}`,
          phoneCall: {
            ...(seconds === undefined ? {} : { seconds }),
            video: c.type === 8,
          },
          sender: c.fromMe === 1 ? "me" : (handles[0] ?? "unknown"),
          source: "phone",
          text: "",
        };
      });
  } finally {
    db.close();
  }
}

export const newestPhone = () =>
  newestArchived(
    "phone",
    "select at, 'Phone & FaceTime call' as words from calls order by at desc limit 1"
  );
