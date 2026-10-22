import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { unzipSync } from "node:zlib";
import { clock } from "../core/clock";
import { HOME } from "../core/platform";
import { type SourceEvent, sourceFile } from "../records/sources";
import {
  ARCHIVE,
  insertAll,
  newestArchived,
  openArchive,
  type Row,
  readArchived,
} from "./archived";
import { fromAppleS } from "./imessage";

// Apple Notes' own store, opened read-only by `copyNotes`, which keeps every version of each note in the archive.
// Only the Notes app writes it, iCloud sync included, so an iPhone edit lands here while Notes runs on the Mac.
// `readNotes` reads those versions back for memory: notes are memory only, never his words for actions.

export const NOTES = join(
  HOME,
  "Library/Group Containers/group.com.apple.notes"
);
const CHECKBOX = 103;

/** A note as the store lists it. `unreadable`: locked (encrypted) or not downloaded yet. `deleted`: in Recently Deleted or marked. */
interface StoreNote {
  at: string;
  deleted: number;
  folder: string | null;
  id: string;
  pk: number;
  shared: number;
  title: string | null;
  unreadable: number;
}

const entity = (name: string) =>
  `(select Z_ENT from Z_PRIMARYKEY where Z_NAME = '${name}')`;

export const listNotes = (db: Database) =>
  db
    .query<StoreNote & { modified: number | null }, []>(
      `select o.Z_PK as pk, o.ZIDENTIFIER as id, o.ZTITLE1 as title, f.ZTITLE2 as folder,
              o.ZSERVERSHAREDATA is not null as shared, o.ZMODIFICATIONDATE1 as modified,
              coalesce(f.ZFOLDERTYPE = 1 or o.ZMARKEDFORDELETION = 1, 0) as deleted,
              coalesce(o.ZISPASSWORDPROTECTED = 1 or o.ZNEEDSINITIALFETCHFROMCLOUD = 1
                or o.ZMODIFICATIONDATE1 is null, 0) as unreadable
         from ZICCLOUDSYNCINGOBJECT o left join ZICCLOUDSYNCINGOBJECT f on f.Z_PK = o.ZFOLDER
        where o.Z_ENT = ${entity("ICNote")}`
    )
    .all()
    .map(({ modified, ...n }) => ({
      ...n,
      at: fromAppleS(modified ?? 0).toISOString(),
    }));

function varint(buf: Uint8Array, at: number): [number, number] {
  let value = 0;
  let shift = 0;
  let i = at;
  for (;;) {
    const byte = buf[i] ?? 0;
    i += 1;
    value += (byte % 128) * 2 ** shift;
    if (byte < 0x80) {
      return [value, i];
    }
    shift += 7;
  }
}

/** A protobuf message's fields in order: a number (varint) or bytes (length-delimited). Fixed-width ones are skipped. */
function* fields(buf: Uint8Array): Generator<[number, number | Uint8Array]> {
  let i = 0;
  while (i < buf.length) {
    const [key, next] = varint(buf, i);
    const wire = key % 8;
    const num = Math.floor(key / 8);
    if (wire === 0) {
      const [value, after] = varint(buf, next);
      i = after;
      yield [num, value];
    } else if (wire === 2) {
      const [len, start] = varint(buf, next);
      i = start + len;
      yield [num, buf.subarray(start, i)];
    } else if (wire === 1 || wire === 5) {
      i = next + (wire === 1 ? 8 : 4);
    } else {
      return;
    }
  }
}

function field(buf: Uint8Array | undefined, n: number) {
  for (const [num, value] of buf ? fields(buf) : []) {
    if (num === n) {
      return value;
    }
  }
}
const sub = (buf: Uint8Array | undefined, n: number) => {
  const v = field(buf, n);
  return v instanceof Uint8Array ? v : undefined;
};
const decode = (buf: Uint8Array | undefined) =>
  buf ? new TextDecoder().decode(buf) : "";

/**
 * A note body (gzip, or zlib before 2019): document (2) → note (3) → text (2), and its attribute runs (5), each covering
 * `length` (1) UTF-16 units of the text. A checklist run (style 103) marks its lines `[ ]` or `[x]` (done, 5 → 2), so a
 * tick is a change of text; an attachment run names the attachment (12 → 1), whose place in the text is U+FFFC.
 */
export function noteBody(data: Uint8Array) {
  const note = sub(sub(unzipSync(data), 2), 3);
  const text = decode(sub(note, 2));
  const marks: string[] = [];
  const attachments: string[] = [];
  let at = 0;
  let line = 0;
  for (const [num, run] of note ? fields(note) : []) {
    if (num !== 5 || !(run instanceof Uint8Array)) {
      continue;
    }
    const length = field(run, 1);
    const span = text.slice(at, at + (typeof length === "number" ? length : 0));
    at += span.length;
    const style = sub(run, 2);
    const checklist = field(style, 1) === CHECKBOX && sub(style, 5);
    const last = line + span.slice(0, -1).split("\n").length - 1;
    for (let l = line; checklist && l <= last; l += 1) {
      marks[l] = field(checklist, 2) ? "[x] " : "[ ] ";
    }
    const attachment = decode(sub(sub(run, 12), 1));
    if (attachment) {
      attachments.push(attachment);
    }
    line += span.split("\n").length - 1;
  }
  return {
    attachments,
    text: text
      .split("\n")
      .map((l, i) => (marks[i] ?? "") + l)
      .join("\n")
      .replaceAll("￼", ""),
  };
}

/**
 * A readable note's text and its attachments as the body holds them now (a gallery's scans with it): type, file name
 * and path in Notes' Media folder, and Apple's own text of it (OCR of a photo or scan, a table's summary).
 */
export function noteVersion(db: Database, source: string, pk: number) {
  const row = db
    .query<{ data: Uint8Array | null }, [number]>(
      "select ZDATA as data from ZICNOTEDATA where ZNOTE = ?"
    )
    .get(pk);
  const { attachments, text } = row?.data
    ? noteBody(row.data)
    : { attachments: [], text: "" };
  const query = db.query<
    {
      account: string | null;
      generation: string | null;
      id: string;
      media: string | null;
      name: string | null;
      text: string | null;
      type: string | null;
    },
    [string]
  >(
    `select a.ZIDENTIFIER as id, a.ZTYPEUTI as type, m.ZFILENAME as name, m.ZIDENTIFIER as media,
            m.ZGENERATION1 as generation, acc.ZIDENTIFIER as account, coalesce(a.ZOCRSUMMARY, a.ZSUMMARY) as text
       from ZICCLOUDSYNCINGOBJECT a
       left join ZICCLOUDSYNCINGOBJECT p on p.Z_PK = a.ZPARENTATTACHMENT
       left join ZICCLOUDSYNCINGOBJECT m on m.Z_PK = a.ZMEDIA
       left join ZICCLOUDSYNCINGOBJECT acc on acc.Z_PK = m.ZACCOUNT6
      where a.Z_ENT = ${entity("ICAttachment")} and ? in (a.ZIDENTIFIER, p.ZIDENTIFIER)
      order by p.Z_PK is not null, a.Z_PK`
  );
  const files = attachments.flatMap((id) =>
    query.all(id).map(({ account, generation, media, ...f }) => ({
      ...f,
      path:
        account && media && f.name
          ? join(
              source,
              `Accounts/${account}/Media/${media}`,
              generation ?? "",
              f.name
            )
          : null,
    }))
  );
  return { files, text };
}

/** An attachment as the archive keeps it (as JSON). */
type NoteFile = ReturnType<typeof noteVersion>["files"][number];

// Each version in the window, with the base of what it changed: the last live version before it (from before the
// window too). A deletion, and a restore after it, are dated when Life saw them: Notes keeps no time for either. A shared
// note's lines may be a co-editor's: they are never his.
const SQL = `select v.rowid as id, v.note as chat, v.title || iif(v.shared, ' (shared)', '') as chatName,
    iif(v.shared, 'shared note', null) as sender, not v.shared as fromMe, iif(v.deleted or p.deleted, v.seenAt, v.at) as at,
    v.text, v.files, v.deleted, p.deleted as restored, l.text as before, l.files as filesBefore
  from versions v
  left join versions p on p.rowid = (select max(x.rowid) from versions x where x.note = v.note and x.rowid < v.rowid)
  left join versions l on l.rowid =
    (select max(x.rowid) from versions x where x.note = v.note and x.rowid < v.rowid and not x.deleted)
  where iif(v.deleted or p.deleted, v.seenAt, v.at) >= ?`;

/** A version's lines: its text, and Apple's text of each attachment that has no file to read (a table, a scan). */
const linesOf = (text: string, files: NoteFile[]) =>
  [
    ...text.split("\n"),
    ...files.flatMap((f) =>
      f.text && !f.path ? [`[attachment: ${f.text}]`] : []
    ),
  ].filter((l) => l.trim());

/** What a version changed, line by line: removed (`− `), then added (`+ `). A first version is its whole text. */
function changes(after: string[], before?: string[]) {
  if (!before) {
    return after;
  }
  const [was, now] = [new Set(before), new Set(after)];
  return [
    ...before.filter((l) => !now.has(l)).map((l) => `− ${l}`),
    ...after.filter((l) => !was.has(l)).map((l) => `+ ${l}`),
  ];
}

/**
 * The note versions the archive saw since `since`, as messages in one chat per note (its title, "(shared)" when
 * shared), his own unless shared: each shows what it changed, a deletion "[deleted the note <title>]", and carries the
 * attachments it added. Two days with the same change (a tick undone and redone) hash the same: the second is a
 * duplicate.
 */
export function readNotes(since: Date, archive = ARCHIVE): SourceEvent[] {
  return readArchived<
    Row & {
      before: string | null;
      files: string;
      filesBefore: string | null;
      restored: number | null;
    }
  >("notes", SQL, since, archive, String, (r) => {
    const files: NoteFile[] = JSON.parse(r.files);
    const had: NoteFile[] = JSON.parse(r.filesBefore ?? "[]");
    const ids = new Set(had.map((f) => f.id));
    return {
      files: files
        .filter((f) => f.path && !ids.has(f.id))
        .map((f) =>
          sourceFile({ name: f.name, path: f.path, ref: `notes:${f.id}` })
        ),
      text: r.deleted
        ? `[deleted the note ${r.chatName ?? r.chat}]`
        : [
            ...(r.restored
              ? [`[restored the note ${r.chatName ?? r.chat}]`]
              : []),
            ...changes(
              linesOf(r.text, files),
              r.before === null ? undefined : linesOf(r.before, had)
            ),
          ].join("\n"),
    };
  });
}

/** The newest note version the archive kept (the status plate). */
export const newestNote = () =>
  newestArchived(
    "notes",
    `select at, 'Note: ' || coalesce(title, '') as words
     from versions order by at desc limit 1`
  );

// One row per version of a note Life saw: its text (checklist lines marked `[ ]`/`[x]`) and attachments' JSON, or its
// deletion (text and files empty). `at` is the note's edit time, or when Life saw it gone from the store. `deleted`
// is each deleted note's last version, named like a chat's (`chatName` its title).
const openNotes = (dir: string) =>
  openArchive(
    dir,
    "notes",
    `create table if not exists versions (
    note text not null, title text, folder text, shared integer not null, at text not null,
    text text not null, files text not null, deleted integer not null, seenAt text not null);
  create index if not exists versionsByNote on versions (note);
  drop view if exists deleted;
  create view deleted as
    select v.*, v.title as chatName, null as senderName, d.seenAt as deletedSeenAt
      from versions v join versions d on d.note = v.note and d.deleted = 1
     where v.rowid = (select max(rowid) from versions x where x.note = v.note and x.rowid < d.rowid) and v.deleted = 0`
  );

// A note edited in the last 2 minutes is still being typed: it is archived once quiet, so typing makes one version.
// ponytail: an edit purged ("Delete now") within those 2 minutes is lost; a shorter wait means more versions.
const QUIET_MS = 120_000;
// More notes than this gone at once is a sign-out or a rebuilt store, not deletions: none is marked.
const MASS_VANISH = 20;
// `<dir>\n<note>` -> the state already compared with its latest version, since a pin or a move changes the edit time
// and not the text.
const checked = new Map<string, string>();
const refused = new Set<string>();

interface Latest {
  at: string;
  deleted: number;
  folder: string | null;
  note: string;
  rowid: number;
  shared: number;
  title: string | null;
}

/** Deleted rows for the archived notes gone from the store; none when too many went at once (logged once). */
function goneRows(
  latest: Latest[],
  present: Set<string>,
  dir: string,
  seenAt: string
) {
  const gone = latest.filter((v) => !(v.deleted || present.has(v.note)));
  if (gone.length > MASS_VANISH || (gone.length > 0 && present.size === 0)) {
    if (!refused.has(dir)) {
      console.error(
        `${seenAt} notes: ${gone.length} gone from the store at once, none marked deleted`
      );
    }
    refused.add(dir);
    return [];
  }
  refused.delete(dir);
  return gone.map((v) => [
    ...[v.note, v.title, v.folder, v.shared, seenAt],
    ...["", "[]", 1, seenAt],
  ]);
}

/** Archives a new version of each note whose text, attachments or deleted state changed. Returns how many. */
export function copyNotes(
  source = NOTES,
  dir = ARCHIVE,
  now = clock().getTime()
): number {
  const path = join(source, "NoteStore.sqlite");
  if (!existsSync(path)) {
    return 0;
  }
  const archive = openNotes(dir);
  const store = new Database(path, { readonly: true });
  try {
    const latest = new Map(
      archive
        .query<Latest, []>(
          `select rowid, note, title, folder, shared, at, deleted from versions
            where rowid in (select max(rowid) from versions group by note)`
        )
        .all()
        .map((v) => [v.note, v])
    );
    const previous = archive.query<
      { deleted: number; files: string; text: string },
      [number]
    >("select text, files, deleted from versions where rowid = ?");
    const seenAt = new Date(now).toISOString();
    const notes = listNotes(store);
    const rows: SQLQueryBindings[][] = [];
    // ponytail: a note is compared again only when its edit time moves, so a change that leaves the time alone (Apple's
    // OCR of a photo finishing later) waits for the next edit.
    for (const n of notes) {
      const key = `${dir}\n${n.id}`;
      const last = latest.get(n.id);
      const stamp = `${last?.rowid} ${n.at} ${n.deleted}`;
      if (
        n.unreadable ||
        (last?.at === n.at && last.deleted === n.deleted) ||
        checked.get(key) === stamp ||
        now - Date.parse(n.at) < QUIET_MS
      ) {
        continue;
      }
      const row = (body: { files: string; text: string }, deleted: number) => [
        ...[n.id, n.title, n.folder, n.shared, n.at],
        ...[body.text, body.files, deleted, seenAt],
      ];
      // A note in Recently Deleted still has its text: its last edit is kept before the deleted row.
      const { files, text } = noteVersion(store, source, n.pk);
      const v = { files: JSON.stringify(files), text };
      const p = last && previous.get(last.rowid);
      if (
        !p ||
        (p.deleted ? !n.deleted : p.text !== v.text || p.files !== v.files)
      ) {
        rows.push(row(v, 0));
      }
      if (n.deleted && !p?.deleted) {
        rows.push(row({ files: "[]", text: "" }, 1));
      }
      checked.set(key, stamp);
    }
    rows.push(
      ...goneRows(
        [...latest.values()],
        new Set(notes.map((n) => n.id)),
        dir,
        seenAt
      )
    );
    return insertAll(
      archive,
      `insert into versions (note, title, folder, shared, at, text, files, deleted, seenAt)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      rows
    );
  } finally {
    store.close();
    archive.close();
  }
}
