import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { basename, extname, join } from "node:path";
import { clock } from "../core/clock";
import { writeWhole } from "../core/files";
import { digest } from "../core/hash";
import { OWNER_DATA_DIR } from "../core/paths";
import { ShapeReport, shapeOf } from "../core/shape-report";
import { ARCHIVE, insertAll } from "./archived";
import { openWhatsapp } from "./whatsapp";

// WhatsApp's own export of a chat ("Export chat", from the phone): a `.txt` of lines, without or with media. A line
// is a message (`[DD/MM/YYYY, HH:MM:SS] Name: text` on an iPhone, `DD/MM/YYYY, HH:MM - Name: text` on Android, a 12h
// clock too), a system line (no name), or a continuation of the message above. Its wall times are Life's zone of that
// day. The copy is kept as it came in `imports/whatsapp/`, and its messages land in the WhatsApp archive as export
// rows (`docs/glossary.md`), like Instagram's: the archiver reads them as messages, never as arrivals.

/** The instant a wall clock in Life's zone reaches (`instantOfWall`, passed in: sources read no memory). */
export type AtWall = (day: string, hm: string) => string;

/** One message of an export, as the archive's row says it. */
export interface ExportedMessage {
  at: string;
  fromMe: boolean;
  sender: string;
  senderName: string;
  text: string;
}

/** An export's chat: its messages oldest first, and the other person's name when the file or its senders say it. */
export interface WhatsappExport {
  chatName: string | null;
  messages: ExportedMessage[];
  /** The name the export gives him, or (no name of his in it) the commonest sender's. */
  owner: string | null;
}

/** Where a WhatsApp export's copies are kept: `imports/whatsapp/`, beside the assistants' copies. */
export const whatsappCopiesDir = (data = OWNER_DATA_DIR) =>
  join(data, "imports", "whatsapp");

/** A copy's file name: the first 12 hex of its sha256 (the same bytes are kept once), then the chat's name if known. */
const COPY = /^([0-9a-f]{12})(?: (.+))?\.txt$/;
/** A chat's text as the phone zips it, or as it exports a chat (its name is not a word of any line). */
const CHAT_FILE = /^(?:_chat|WhatsApp Chat with .+)\.txt$/i;
/** The chat's name in an export's file name, or in the folder an iPhone's zip unzips to. */
const NAMED_CHAT = /^WhatsApp Chat (?:with|-) (.+?)(?:\.txt|\.zip)?$/i;

/** Whether `path` is a WhatsApp chat export: a `.txt`, or a folder holding `_chat.txt` or `WhatsApp Chat with …`. */
export function isWhatsappExport(path: string) {
  if (!existsSync(path)) {
    return false;
  }
  if (!statSync(path).isDirectory()) {
    return extname(path).toLowerCase() === ".txt";
  }
  return readdirSync(path).some((f) => CHAT_FILE.test(f));
}

/** Whether its own name says it is WhatsApp's chat text: one Life can't read yet is then kept for an update. */
export const isNamedWhatsappExport = (path: string) =>
  CHAT_FILE.test(basename(chatFileOf(path)));

/** The export's text file: `path` itself, or the chat text a folder holds (`_chat.txt` first). */
function chatFileOf(path: string) {
  if (!statSync(path).isDirectory()) {
    return path;
  }
  const names = readdirSync(path)
    .filter((f) => CHAT_FILE.test(f))
    .sort();
  const name = names.includes("_chat.txt") ? "_chat.txt" : names[0];
  if (!name) {
    throw new Error(`${path} holds no WhatsApp chat text`);
  }
  return join(path, name);
}

/** The chat's name as the file's (or the folder's) own name says it: `WhatsApp Chat with Jane Doe.txt`, `WhatsApp Chat - Jane Doe`; none for `_chat.txt`. */
export const chatNameOf = (path: string) =>
  NAMED_CHAT.exec(basename(path))?.[1]?.trim();

/** The lines as WhatsApp writes them: without its invisible marks, its BOM and its narrow no-break spaces. */
const MARKS = /[\u200e\u200f\ufeff]/g;
const NARROW = /[\u202f\u00a0]/g;
const LINES = /\r?\n/;
const linesOf = (text: string) =>
  text.replaceAll(MARKS, "").replaceAll(NARROW, " ").split(LINES);

const CLOCK = String.raw`(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([AaPp]\.?[Mm]\.?)?`;
/** An iPhone's line: `[10/03/2025, 09:05:03] Name: text`, its clock 12h or 24h. */
const IOS = new RegExp(
  String.raw`^\[(\d{1,2})([./])(\d{1,2})\2(\d{2,4}),\s*${CLOCK}\]\s?(.*)$`
);
/** Android's: `10/03/2025, 09:05 - Name: text`. */
const ANDROID = new RegExp(
  String.raw`^(\d{1,2})([./])(\d{1,2})\2(\d{2,4}),\s*${CLOCK}\s*[-–]\s?(.*)$`
);
/** An afternoon in a 12h clock. */
const PM = /p/i;
/** The rest of a line: the sender, then the words. A system line has no `Name: ` and is skipped. */
const SPOKEN = /^([^:\n]{1,120}): ?([\s\S]*)$/;

/** A line's stamp as both phones write it, with the rest of the line after it. */
function stampedOf(line: string) {
  const match = IOS.exec(line) ?? ANDROID.exec(line);
  if (!match) {
    return;
  }
  const [, a, , b, year, hh, mm, ss, ampm, rest] = match;
  return {
    a: Number(a),
    ampm,
    b: Number(b),
    hh: Number(hh),
    mm: Number(mm),
    rest: rest ?? "",
    ss: Number(ss ?? 0),
    year: Number(year),
  };
}

const two = (n: number) => `${n}`.padStart(2, "0");
const sameName = (a: string, b: string) =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * A chat export as read: its messages, whose side each is on (`ownerNames`, his names in truth/), and the name the
 * export gives him. The day/month order comes from the data (a field over 12 says which it is; else day first), and
 * each line's wall time becomes an instant through `atWall`. What cannot be a line of any format is a `ShapeReport`.
 */
export function parseWhatsappExport(
  text: string,
  o: { atWall: AtWall; name?: string; ownerNames: string[] }
): WhatsappExport {
  const lines = linesOf(text);
  // WhatsApp ends its file with a line break: the empty line after the last message is no part of it.
  if (lines.at(-1) === "") {
    lines.pop();
  }
  const stamped: NonNullable<ReturnType<typeof stampedOf>>[] = [];
  for (const line of lines) {
    const stamp = stampedOf(line);
    if (stamp) {
      stamped.push(stamp);
      continue;
    }
    const last = stamped.at(-1);
    if (!last) {
      if (line.trim()) {
        throw shapeOf("whatsapp-txt", { counts: { lines: lines.length } });
      }
      continue;
    }
    // A line with no stamp continues the message above it (its own blank lines too).
    last.rest += `\n${line}`;
  }
  if (stamped.length === 0) {
    throw shapeOf("whatsapp-txt", { counts: { lines: lines.length } });
  }
  const dayFirst =
    stamped.some((s) => s.a > 12) || !stamped.some((s) => s.b > 12);
  const at = (s: (typeof stamped)[number]) => {
    const [day, month] = dayFirst ? [s.a, s.b] : [s.b, s.a];
    if (month < 1 || month > 12 || day < 1 || day > 31) {
      return;
    }
    const hour = s.ampm ? (s.hh % 12) + (PM.test(s.ampm) ? 12 : 0) : s.hh;
    const year = s.year < 100 ? (s.year < 70 ? 2000 : 1900) + s.year : s.year;
    // The seconds the export writes too: two messages of one minute keep their order.
    const start = Date.parse(
      o.atWall(`${year}-${two(month)}-${two(day)}`, `${two(hour)}:${two(s.mm)}`)
    );
    return new Date(start + s.ss * 1000).toISOString();
  };
  const said = stamped.flatMap((s) => {
    const when = at(s);
    const spoken = SPOKEN.exec(s.rest);
    return when && spoken
      ? [
          {
            at: when,
            name: (spoken[1] as string).trim(),
            text: spoken[2] ?? "",
          },
        ]
      : [];
  });
  const count = new Map<string, number>();
  for (const s of said) {
    count.set(s.name, (count.get(s.name) ?? 0) + 1);
  }
  const senders = [...count].sort((a, b) => b[1] - a[1]).map(([name]) => name);
  // ponytail: with no name of his in the export (another phone's, or truth renamed since), the commonest sender is
  // read as him, and a chat whose file gave no name takes its commonest other member's; a system line of a locale that
  // puts a colon in it reads as a message. Each shows in the chat and a correction keeps the row.
  const owner =
    senders.find((s) => o.ownerNames.some((name) => sameName(name, s))) ??
    senders[0] ??
    null;
  const others = senders.filter((s) => s !== owner);
  return {
    chatName: o.name ?? others[0] ?? null,
    messages: said.map((s) => ({
      at: s.at,
      fromMe: s.name === owner,
      sender: s.name === owner ? "me" : s.name,
      senderName: s.name,
      text: s.text,
    })),
    owner,
  };
}

/** An export read from its file (or from the folder holding its chat text), its chat's name as the file gives it. */
export const readWhatsappExport = (
  path: string,
  o: { atWall: AtWall; ownerNames: string[] }
) =>
  parseWhatsappExport(readFileSync(chatFileOf(path), "utf8"), {
    ...o,
    name: chatNameOf(path),
  });

/**
 * An export kept as it came at `imports/whatsapp/<12 hex of its sha256> <chat's name>.txt` (the name only the file or
 * folder gave, so the copy keeps it): never rewritten, the same bytes being one copy.
 */
export function copyWhatsappExport(from: string, copies = whatsappCopiesDir()) {
  const text = chatFileOf(from);
  const bytes = readFileSync(text);
  const hex = digest("sha256", bytes, 12);
  const name = chatNameOf(text) ?? chatNameOf(from);
  const path = join(copies, `${hex}${name ? ` ${name}` : ""}.txt`);
  const isNew =
    !existsSync(copies) ||
    !readdirSync(copies).some((f) => COPY.exec(f)?.[1] === hex);
  if (isNew) {
    mkdirSync(copies, { recursive: true });
    writeWhole(path, bytes);
  }
  return { hex, isNew, path };
}

/**
 * What the archive does with an export copy: nothing while another has to be read first (its export rows are in by
 * id), and nothing once the night is over. `failed` is the copies whose shape Life does not know: they are skipped, and
 * read again only by a new process (an update), with nothing stored.
 */
export interface WhatsappImport {
  added: number;
  copies: number;
  failed: ShapeReport[];
}

const INSERT = `insert or ignore into messages
  (id, chat, chatName, sender, senderName, fromMe, at, type, text, media, seenAt)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

/**
 * Reads each copy in `imports/whatsapp/` not in `tried` and with no rows in the WhatsApp archive yet, and writes its
 * messages as export rows (`export:<hex>/<ms>/<n>`, chat `export:<hex>`): only those before the archive's earliest
 * copied message (`ponytail:` one cut for the whole archive, no per-message match; no copied message yet, all of them).
 * Insert only, one transaction. `tried` takes each copy either way, so a failure waits for a new process (an update).
 */
export function importWhatsappExports(
  tried: Set<string>,
  o: {
    archive?: string;
    atWall: AtWall;
    copies?: string;
    now?: number;
    ownerNames: string[];
  }
): WhatsappImport {
  const copies = o.copies ?? whatsappCopiesDir();
  if (!existsSync(copies)) {
    return { added: 0, copies: 0, failed: [] };
  }
  const fresh = readdirSync(copies)
    .flatMap((f) => {
      const [, hex, name] = COPY.exec(f) ?? [];
      return hex ? [{ hex, name, path: join(copies, f) }] : [];
    })
    .filter((c) => !tried.has(c.hex))
    .sort((a, b) => a.hex.localeCompare(b.hex));
  if (fresh.length === 0) {
    return { added: 0, copies: 0, failed: [] };
  }
  const seenAt = new Date(o.now ?? clock().getTime()).toISOString();
  const db = openWhatsapp(o.archive ?? ARCHIVE);
  const failed: ShapeReport[] = [];
  const rows: (string | number | null)[][] = [];
  try {
    const cut =
      db
        .query<{ at: string | null }, []>(
          "select min(at) as at from messages where id not like 'export:%'"
        )
        .get()?.at ?? undefined;
    for (const copy of fresh) {
      tried.add(copy.hex);
      const have = db
        .query("select 1 from messages where chat = ? limit 1")
        .get(`export:${copy.hex}`);
      if (have) {
        continue;
      }
      let read: WhatsappExport;
      try {
        read = parseWhatsappExport(readFileSync(copy.path, "utf8"), {
          ...o,
          name: copy.name,
        });
      } catch (error) {
        if (!(error instanceof ShapeReport)) {
          throw error;
        }
        failed.push(error);
        continue;
      }
      read.messages.forEach((m, n) => {
        if (cut && m.at >= cut) {
          return;
        }
        rows.push([
          `export:${copy.hex}/${Date.parse(m.at)}/${n + 1}`,
          `export:${copy.hex}`,
          read.chatName,
          m.sender,
          m.senderName,
          m.fromMe ? 1 : 0,
          m.at,
          0,
          m.text,
          "",
          seenAt,
        ]);
      });
    }
    return { added: insertAll(db, INSERT, rows), copies: fresh.length, failed };
  } finally {
    db.close();
  }
}
