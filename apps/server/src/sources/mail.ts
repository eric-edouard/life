import { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HOME } from "../core/platform";
import type { SourceEvent, SourceFile } from "../records/source";
import type { Newest } from "./contract";
import { sourceFile } from "./contract";

// Apple Mail's local store, every account Mail.app syncs, opened read-only. Never written.

const MAIL = join(HOME, "Library", "Mail");
const ACCOUNTS_DB = join(HOME, "Library", "Accounts", "Accounts4.sqlite");
const SNIPPET = 1500;
const SENT = /sent|envoy/i;
/**
 * The words of mailboxes never read as mail. Drafts were never sent: read as mail, an unsent draft would pass for
 * something he wrote to someone.
 */
export const SKIPPED_BOXES = [
  "junk",
  "spam",
  "trash",
  "corbeille",
  "deleted",
  "supprim",
  "indesirable",
  "draft",
  "brouillon",
];
const SKIP = new RegExp(SKIPPED_BOXES.join("|"), "i");
const VERSION_DIR = /^V\d+$/;
const MAILBOX_URL = /^\w+:\/\/([^/]+)\/(.*)$/;
const BLANK_LINE = /\r?\n\r?\n/;
const LEADING_BLANK_LINE = /^\r?\n\r?\n/;
const LEADING_NEWLINE = /^\r?\n/;
const FOLDED = /\r?\n[ \t]+/g;
const NEWLINE = /\r?\n/;

/** The newest `~/Library/Mail/V<n>` directory. */
export function mailRoot(base = MAIL): string {
  const versions = readdirSync(base)
    .filter((d) => VERSION_DIR.test(d))
    .sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  const latest = versions.at(-1);
  if (!latest) {
    throw new Error(`no Mail store under ${base}`);
  }
  return join(base, latest);
}

const openIndex = (root: string) =>
  new Database(join(root, "MailData", "Envelope Index"), { readonly: true });

/** The newest message in Mail's store, its sender and subject (the status snapshot). */
export function newestMail(): Newest {
  const db = openIndex(mailRoot());
  try {
    const r = db
      .query<
        { at: number; comment: string | null; subject: string | null },
        []
      >(
        `select m.date_received as at, s.subject, a.comment from messages m
           left join subjects s on s.ROWID = m.subject left join addresses a on a.ROWID = m.sender
         order by m.date_received desc limit 1`
      )
      .get();
    return r
      ? {
          at: new Date(r.at * 1000).toISOString(),
          words: [`${r.comment || "?"}: ${r.subject ?? ""}`],
        }
      : { at: null };
  } finally {
    db.close();
  }
}

// "imap://<uuid>/%5BGmail%5D/Sent%20Mail" -> { account: uuid, path: ["[Gmail]", "Sent Mail"] }
function parseMailboxUrl(url: string) {
  const m = url.match(MAILBOX_URL);
  return m?.[1] && m[2] !== undefined
    ? { account: m[1], path: m[2].split("/").map(decodeURIComponent) }
    : null;
}
const plain = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "");
/** A mailbox never read as mail (junk, trash, drafts), by its name. */
export const isSkippedBox = (name: string) => SKIP.test(plain(name));
/** A mailbox of sent mail, by its name. */
export const isSentBox = (name: string) => SENT.test(plain(name));
const mailboxName = (url: string) => parseMailboxUrl(url)?.path.at(-1) ?? "";

interface MailAccount {
  addresses: string[];
  id: string;
  name: string;
}

/** Accounts with mail in the store: display name and the owner's addresses (account login + Sent senders). */
export function mailAccounts(
  root = mailRoot(),
  accountsDb = ACCOUNTS_DB
): MailAccount[] {
  const db = openIndex(root);
  const accounts = new Map<string, Set<string>>();
  try {
    // Gmail keeps sent mail in All Mail and only labels it Sent.
    const senders = db.query<{ address: string }, [number]>(
      `select distinct lower(a.address) as address
         from messages m join addresses a on a.ROWID = m.sender
        where m.mailbox = ?1 or m.ROWID in (select message_id from labels where mailbox_id = ?1)`
    );
    const mailboxes = db
      .query<{ id: number; url: string }, []>(
        "select ROWID as id, url from mailboxes"
      )
      .all();
    for (const { id, url } of mailboxes) {
      const account = parseMailboxUrl(url)?.account;
      // "local:///..." is On My Mac, not an account.
      if (!account) {
        continue;
      }
      const addresses = accounts.get(account) ?? new Set<string>();
      accounts.set(account, addresses);
      if (isSentBox(mailboxName(url))) {
        for (const { address } of senders.all(id)) {
          addresses.add(address);
        }
      }
    }
  } finally {
    db.close();
  }
  const names = accountNames(accountsDb);
  return [...accounts].map(([id, addresses]) => {
    const known = names.get(id);
    if (known?.username.includes("@")) {
      addresses.add(known.username.toLowerCase());
    }
    return { addresses: [...addresses].sort(), id, name: known?.name ?? id };
  });
}

// Mail's account folders are named by the Internet Accounts identifier; names live on the parent account.
function accountNames(path: string) {
  const names = new Map<string, { name: string; username: string }>();
  if (!existsSync(path)) {
    return names;
  }
  const db = new Database(path, { readonly: true });
  try {
    const rows = db
      .query<{ id: string; name: string | null; username: string | null }, []>(
        `select a.ZIDENTIFIER as id,
                coalesce(p.ZACCOUNTDESCRIPTION, a.ZACCOUNTDESCRIPTION) as name,
                coalesce(p.ZUSERNAME, a.ZUSERNAME) as username
           from ZACCOUNT a left join ZACCOUNT p on p.Z_PK = a.ZPARENTACCOUNT`
      )
      .all();
    for (const r of rows) {
      names.set(r.id, {
        name: r.name ?? r.username ?? r.id,
        username: r.username ?? "",
      });
    }
  } finally {
    db.close();
  }
  return names;
}

// --- message parsing -------------------------------------------------------------------------------

interface Part {
  body: string; // raw bytes as latin1
  headers: Map<string, string>;
}

function splitPart(raw: string): Part {
  const cut = raw.search(BLANK_LINE);
  const head = cut < 0 ? raw : raw.slice(0, cut);
  const body = cut < 0 ? "" : raw.slice(cut).replace(LEADING_BLANK_LINE, "");
  const list: [string, string][] = [];
  for (const line of head.replace(FOLDED, " ").split(NEWLINE)) {
    const i = line.indexOf(":");
    if (i > 0) {
      list.push([
        line.slice(0, i).trim().toLowerCase(),
        line.slice(i + 1).trim(),
      ]);
    }
  }
  return { body, headers: new Map(list) };
}

const EXTENDED = /^([^']*)'[^']*'(.*)$/;

/**
 * A header parameter, also when RFC 2231 split it (`name*0=…; name*1=…`) or percent-encoded it
 * (`name*=utf-8''R%C3%A9cap.pdf`, the first part `name*0*=`).
 */
function param(header: string, name: string) {
  const single = header.match(new RegExp(`${name}\\s*=\\s*"?([^";]+)"?`, "i"));
  const parts = [
    ...header.matchAll(
      new RegExp(`${name}\\*(\\d*)(\\*?)\\s*=\\s*"?([^";]+)"?`, "gi")
    ),
  ];
  const value = parts.map((m) => m[3]).join("");
  // Percent-encoded when the first part is `name*=` or `name*0*=`: quoted-printable with % for = (it has no bare =).
  const [, index, star] = parts[0] ?? [];
  const extended = !index || star ? value.match(EXTENDED) : null;
  if (single || !extended) {
    return single?.[1] ?? (value || undefined);
  }
  return decode(`${extended[2]}`.replaceAll("%", "="), "q", `${extended[1]}`);
}

/** The bytes of `s` in `encoding` (base64 or "b", quoted-printable or "q", else as is). */
function bytesOf(s: string, encoding: string): Buffer {
  if (encoding === "base64" || encoding === "b") {
    return Buffer.from(s.replace(/\s+/g, ""), "base64");
  }
  if (encoding === "quoted-printable" || encoding === "q") {
    return Buffer.from(
      s
        .replace(/[=]\r?\n/g, "")
        .replace(/[=]([0-9A-Fa-f]{2})/g, (_, h: string) =>
          String.fromCharCode(Number.parseInt(h, 16))
        ),
      "latin1"
    );
  }
  return Buffer.from(s, "latin1");
}

/** The text of `s` in `encoding` (as `bytesOf`) and `charset`. */
function decode(s: string, encoding: string, charset: string): string {
  const bytes = bytesOf(s, encoding);
  try {
    return new TextDecoder(charset as Bun.Encoding).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

const decodeBody = ({ body, headers }: Part) =>
  decode(
    body,
    (headers.get("content-transfer-encoding") ?? "").toLowerCase(),
    param(headers.get("content-type") ?? "", "charset") ?? "utf-8"
  );

const ENCODED_WORD = /[=]\?([^?]+)\?([bq])\?([^?]*)\?=/gi;
const BETWEEN_WORDS = /\?=\s+=\?/g;
/** A header value with its encoded words decoded (RFC 2047): "=?UTF-8?Q?Cr=C3=A9ation.jpg?=" -> "Création.jpg". */
export const decodeWords = (s: string) =>
  s
    .replace(BETWEEN_WORDS, "?==?")
    .replace(ENCODED_WORD, (_, charset: string, b: string, text: string) =>
      decode(text.replaceAll("_", " "), b.toLowerCase(), charset)
    );

const ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
};

const htmlToText = (html: string) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(x?)([0-9a-f]+);/gi, (_, x: string, n: string) =>
      String.fromCodePoint(Number.parseInt(n, x ? 16 : 10))
    )
    .replace(
      /&(\w+);/g,
      (m, name: string) => ENTITIES[name.toLowerCase()] ?? m
    );

/** The parts inside a multipart part, or null when it isn't one. */
function childrenOf(part: Part): Part[] | null {
  const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
  if (!type.startsWith("multipart/")) {
    return null;
  }
  const boundary = param(part.headers.get("content-type") ?? "", "boundary");
  return boundary
    ? part.body
        .split(`--${boundary}`)
        .slice(1)
        .filter((c) => !c.startsWith("--"))
        .map((c) => splitPart(c.replace(LEADING_NEWLINE, "")))
    : [];
}

/** The best text body of a MIME part: text/plain first, else stripped text/html. */
function textOf(part: Part): { html: boolean; text: string } | null {
  const type = (part.headers.get("content-type") ?? "text/plain").toLowerCase();
  const parts = childrenOf(part);
  if (parts) {
    const children = parts
      .map(textOf)
      .filter((t): t is { html: boolean; text: string } => !!t?.text.trim());
    // A partial .emlx can keep an empty text/plain next to the full HTML.
    return children.find((t) => !t.html) ?? children[0] ?? null;
  }
  if (
    (part.headers.get("content-disposition") ?? "").startsWith("attachment")
  ) {
    return null;
  }
  if (type.startsWith("text/plain")) {
    return { html: false, text: decodeBody(part) };
  }
  if (type.startsWith("text/html")) {
    return { html: true, text: htmlToText(decodeBody(part)) };
  }
  return null;
}

/**
 * The files in a MIME part of message `id`, kept at `path`: every leaf that names one, cited by its part number as IMAP
 * gives it ("2", "2.1"). A part a partial .emlx left out is in Mail's Attachments folder, when Mail downloaded it.
 */
function filesOf(part: Part, path: string, id: string, at = ""): SourceFile[] {
  const parts = childrenOf(part);
  if (parts) {
    return parts.flatMap((p, i) =>
      filesOf(p, path, id, at ? `${at}.${i + 1}` : `${i + 1}`)
    );
  }
  const type = part.headers.get("content-type") ?? "";
  const named =
    param(part.headers.get("content-disposition") ?? "", "filename") ??
    param(type, "name");
  if (!named) {
    return [];
  }
  const name = decodeWords(named);
  const section = at || "1";
  // A part Mail's <rowid>.emlx or <rowid>.partial.emlx left out is in its Attachments folder; a Maildir file holds all.
  const saved = path.endsWith(".emlx")
    ? join(
        dirname(dirname(path)),
        "Attachments",
        basename(path).split(".")[0] ?? "",
        section,
        name
      )
    : undefined;
  return [
    sourceFile({
      mime: type.split(";")[0]?.trim().toLowerCase(),
      name,
      path: part.body.trim() ? path : saved,
      ref: `${id}#${section}`,
    }),
  ];
}

/**
 * The bytes of the file `ref` cites (`mail:<Message-ID>#<part>`, as `filesOf` makes it) in the message file at `path`
 * (an .emlx or a Maildir file), if it is there.
 */
export function messagePart(path: string, ref: string) {
  let part: Part | undefined = splitPart(messageIn(path));
  for (const i of ref.slice(ref.lastIndexOf("#") + 1).split(".")) {
    const parts: Part[] | null = childrenOf(part);
    // A message that is not multipart is its own part 1.
    if (parts || i !== "1") {
      part = parts?.[Number(i) - 1];
    }
    if (!part) {
      return;
    }
  }
  return bytesOf(
    part.body,
    (part.headers.get("content-transfer-encoding") ?? "").toLowerCase()
  );
}

function snippetOf(message: Part) {
  const text = textOf(message)?.text ?? "";
  return text
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim()
    .slice(0, SNIPPET);
}

/** The RFC 822 message in a file: an .emlx holds a byte-length line, the message, then a plist; any other file is the message. */
function messageIn(path: string) {
  const file = readFileSync(path);
  if (!path.endsWith(".emlx")) {
    return file.toString("latin1");
  }
  const newline = file.indexOf(10);
  const length = Number.parseInt(file.subarray(0, newline).toString(), 10);
  return file.subarray(newline + 1, newline + 1 + length).toString("latin1");
}

// Mail keeps message ROWID 123456 at <mailbox>.mbox/<store uuid>/Data/3/2/1/Messages/123456.emlx.
function emlxPath(root: string, url: string, rowid: number): string | null {
  const box = parseMailboxUrl(url);
  if (!box) {
    return null;
  }
  const mbox = join(root, box.account, ...box.path.map((p) => `${p}.mbox`));
  if (!existsSync(mbox)) {
    return null;
  }
  const store = readdirSync(mbox).find((d) =>
    existsSync(join(mbox, d, "Data"))
  );
  if (!store) {
    return null;
  }
  const thousands = Math.floor(rowid / 1000);
  const digits = thousands ? [...String(thousands)].reverse() : [];
  const dir = join(mbox, store, "Data", ...digits, "Messages");
  return (
    [`${rowid}.emlx`, `${rowid}.partial.emlx`]
      .map((f) => join(dir, f))
      .find((f) => existsSync(f)) ?? null
  );
}

// --- messages ------------------------------------------------------------------------------------

interface Row {
  bulk: number;
  conversation: number;
  globalId: number;
  header: string | null;
  mailbox: string;
  prefix: string | null;
  received: number;
  rowid: number;
  sender: string | null;
  subject: string | null;
}

/** Messages received at or after `since`, oldest first, with where each is stored. */
function messagesSince(since: Date, root = mailRoot()): Row[] {
  const db = openIndex(root);
  try {
    return db
      .query<Row, [number]>(
        `select m.ROWID as rowid, m.global_message_id as globalId, m.date_received as received,
                m.conversation_id as conversation, m.subject_prefix as prefix,
                s.subject, a.address as sender, mb.url as mailbox, g.message_id_header as header,
                (coalesce(m.list_id_hash, 0) != 0 or coalesce(m.unsubscribe_type, 0) != 0) as bulk
           from messages m
           join mailboxes mb on mb.ROWID = m.mailbox
           left join subjects s on s.ROWID = m.subject
           left join addresses a on a.ROWID = m.sender
           left join message_global_data g on g.ROWID = m.global_message_id
          where m.date_received >= ? and m.deleted = 0
          order by m.date_received`
      )
      .all(Math.floor(since.getTime() / 1000));
  } finally {
    db.close();
  }
}

/**
 * Each message file's headers, text and files, read once per process: a file never changes (a partial one is replaced
 * by the whole one, under another name), so `search` reads only new mail after its first call.
 * Whether a partial message's saved attachment exists is read then too: one Mail downloads later shows at the next
 * process. ponytail: keeps every message read (up to about 2 KB each) for the process's life: the nightly's three years
 * for closeness, and in the server every mail any search's `from` reached; prune it if memory matters.
 */
const parsed = new Map<
  string,
  { files: SourceFile[]; headers: Map<string, string>; snippet: string }
>();
/** The message in the file at `path`, its files cited by the id `idOf` gives it. */
export function readMessage(
  path: string,
  idOf: (headers: Map<string, string>) => string
) {
  const known = parsed.get(path);
  if (known) {
    return known;
  }
  const message = splitPart(messageIn(path));
  const read = {
    files: filesOf(message, path, idOf(message.headers)),
    headers: message.headers,
    snippet: snippetOf(message),
  };
  parsed.set(path, read);
  return read;
}

const MESSAGE_ID = /<([^>]+)>/;
/** A message's id: its Message-ID header without its brackets, else what its store names it by. */
export const mailIdOf = (
  header: string | null | undefined,
  fallback: number | string
) => `mail:${header?.match(MESSAGE_ID)?.[1] || header?.trim() || fallback}`;

/** A message as a store gives it: its file (when it is there) and what the store says of it. */
export interface StoredMessage {
  at: string;
  bulk: boolean;
  chat: string;
  /** The subject without its prefix. */
  chatName: string;
  id: string;
  /** In a mailbox of sent mail: its sender is one of his addresses. */
  isSent: boolean;
  /** In a mailbox never read as mail (junk, trash, drafts). */
  isSkipped: boolean;
  path: string | null;
  /** "Re: ", "Fwd: ". */
  prefix: string;
  sender: string;
}

/**
 * Each message once, as an event: a message stored in a skipped mailbox is skipped everywhere (Gmail keeps a draft's
 * copy in All Mail too). His own are from `addresses` or a sender of his sent mail.
 */
export function mailEvents(
  stored: StoredMessage[],
  addresses: string[]
): SourceEvent[] {
  const mine = new Set([
    ...addresses.map((a) => a.toLowerCase()),
    ...stored.filter((m) => m.isSent).map((m) => m.sender),
  ]);
  const seen = new Set(stored.filter((m) => m.isSkipped).map((m) => m.id));
  const events: SourceEvent[] = [];
  for (const m of stored) {
    if (seen.has(m.id)) {
      continue;
    }
    seen.add(m.id);
    const read = m.path ? readMessage(m.path, () => m.id) : null;
    events.push({
      at: m.at,
      bulk: m.bulk,
      chat: m.chat,
      ...(m.chatName ? { chatName: m.chatName } : {}),
      files: read?.files ?? [],
      fromMe: mine.has(m.sender),
      id: m.id,
      sender: m.sender,
      source: "mail",
      text: `${m.prefix}${m.chatName}\n${read?.snippet ?? ""}`.trim(),
    });
  }
  return events;
}

export function readMail(
  since: Date,
  root = mailRoot(),
  accountsDb = ACCOUNTS_DB
): SourceEvent[] {
  return mailEvents(
    messagesSince(since, root).map((r) => {
      const subject = r.subject ?? "";
      return {
        at: new Date(r.received * 1000).toISOString(),
        bulk: r.bulk === 1,
        chat: r.conversation
          ? `mail:${r.conversation}`
          : `${r.mailbox}#${subject}`,
        chatName: subject,
        id: mailIdOf(r.header, r.globalId),
        isSent: isSentBox(mailboxName(r.mailbox)),
        isSkipped: isSkippedBox(mailboxName(r.mailbox)),
        path: emlxPath(root, r.mailbox, r.rowid),
        prefix: r.prefix ?? "",
        sender: (r.sender ?? "unknown").toLowerCase(),
      };
    }),
    mailAccounts(root, accountsDb).flatMap((a) => a.addresses)
  );
}
