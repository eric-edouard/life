import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { HOME } from "../core/platform";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent, SourceFile } from "../records/source";
import { handleKey, readContacts } from "./contacts";
import type { Newest } from "./contract";
import { sourceFile } from "./contract";

// Apple Mail's local store, every account Mail.app syncs, opened read-only. Never written.

const MAIL = join(HOME, "Library", "Mail");
const ACCOUNTS_DB = join(HOME, "Library", "Accounts", "Accounts4.sqlite");
const SNIPPET = 1500;
// A whole word of the plain name: "Sent Mail", "Messages envoyés", never "Consent forms" or "À envoyer".
const SENT = /\b(?:sent|envoyes?)\b/i;
// Drafts were never sent: read as mail, an unsent draft would pass for something he wrote to someone.
const SKIP =
  /junk|spam|trash|corbeille|deleted|supprim|indesirable|draft|brouillon/i;
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
  openReadOnly(join(root, "MailData", "Envelope Index"));

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
const mailboxName = (url: string) =>
  plain(parseMailboxUrl(url)?.path.at(-1) ?? "");

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
      if (SENT.test(mailboxName(url))) {
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
  const db = openReadOnly(path);
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

// --- .emlx parsing -------------------------------------------------------------------------------

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
const decodeWords = (s: string) =>
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
 * The files in a MIME part of message `id`, kept at `emlx`: every leaf that names one, cited by its part number as IMAP
 * gives it ("2", "2.1"). A part a partial .emlx left out is in Mail's Attachments folder, when Mail downloaded it.
 */
function filesOf(part: Part, emlx: string, id: string, at = ""): SourceFile[] {
  const parts = childrenOf(part);
  if (parts) {
    return parts.flatMap((p, i) =>
      filesOf(p, emlx, id, at ? `${at}.${i + 1}` : `${i + 1}`)
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
  // <rowid>.emlx or <rowid>.partial.emlx
  const rowid = basename(emlx).split(".")[0] ?? "";
  const saved = join(dirname(dirname(emlx)), "Attachments", rowid, section);
  return [
    sourceFile({
      mime: type.split(";")[0]?.trim().toLowerCase(),
      name,
      path: part.body.trim() ? emlx : join(saved, name),
      ref: `${id}#${section}`,
    }),
  ];
}

/** The bytes of the file `ref` cites (`mail:<Message-ID>#<part>`, as `filesOf` makes it) in the .emlx at `emlx`, if it is there. */
export function emlxPart(emlx: string, ref: string) {
  let part: Part | undefined = splitPart(rfc822(readFileSync(emlx)));
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

/** The RFC 822 message inside an .emlx file: a byte-length line, the message, then a plist. */
function rfc822(file: Buffer) {
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
  transaction: number;
}

/** Messages received at or after `since`, oldest first, with where each is stored. */
function messagesSince(since: Date, root = mailRoot()): Row[] {
  const db = openIndex(root);
  try {
    // Mail's own sorting, on a Mac that sorts mail: category 1 is Transactions (orders, bookings, receipts, deliveries, bank).
    const sorts = db
      .query(
        "select 1 from pragma_table_info('message_global_data') where name = 'model_category'"
      )
      .get();
    return db
      .query<Row, [number]>(
        `select m.ROWID as rowid, m.global_message_id as globalId, m.date_received as received,
                m.conversation_id as conversation, m.subject_prefix as prefix,
                s.subject, a.address as sender, mb.url as mailbox, g.message_id_header as header,
                (coalesce(m.list_id_hash, 0) != 0 or coalesce(m.unsubscribe_type, 0) != 0) as bulk,
                ${sorts ? "coalesce(g.model_category, 0) = 1" : "0"} as "transaction"
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
 * Each message file's text and files, read once per process: a file never changes (a partial one is replaced by the
 * whole one, under another name), so `search` reads only new mail after its first call.
 * Whether a partial message's saved attachment exists is read then too: one Mail downloads later shows at the next
 * process. ponytail: keeps every message read (up to about 2 KB each) for the process's life: the nightly's three years
 * for closeness, and in the server every mail any search's `from` reached; prune it if memory matters.
 */
const parsed = new Map<string, { files: SourceFile[]; snippet: string }>();
function parse(path: string, id: string) {
  const message = splitPart(rfc822(readFileSync(path)));
  const read = {
    files: filesOf(message, path, id),
    snippet: snippetOf(message),
  };
  parsed.set(path, read);
  return read;
}

export function readMail(
  since: Date,
  root = mailRoot(),
  accountsDb = ACCOUNTS_DB,
  contacts: Map<string, string> = readContacts()
): SourceEvent[] {
  const mine = new Set(
    mailAccounts(root, accountsDb).flatMap((a) => a.addresses)
  );
  const rows = messagesSince(since, root);
  const idOf = (r: Row) =>
    `mail:${r.header?.replace(/^<|>$/g, "") || r.globalId}`;
  // A message in a skipped mailbox is skipped everywhere: Gmail keeps a draft's copy in All Mail too.
  const seen = new Set(
    rows.filter((r) => SKIP.test(mailboxName(r.mailbox))).map(idOf)
  );
  const events: SourceEvent[] = [];
  for (const r of rows) {
    const id = idOf(r);
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    const subject = r.subject ?? "";
    const path = emlxPath(root, r.mailbox, r.rowid);
    const read = path ? (parsed.get(path) ?? parse(path, id)) : null;
    const sender = (r.sender ?? "unknown").toLowerCase();
    events.push({
      at: new Date(r.received * 1000).toISOString(),
      bulk: r.bulk === 1,
      chat: r.conversation
        ? `mail:${r.conversation}`
        : `${r.mailbox}#${subject}`,
      ...(subject ? { chatName: subject } : {}),
      ...(contacts.has(handleKey(sender)) ? { contact: true as const } : {}),
      ...(r.transaction === 1 ? { transaction: true as const } : {}),
      files: read?.files ?? [],
      fromMe: mine.has(sender),
      id,
      sender,
      source: "mail",
      text: `${r.prefix ?? ""}${subject}\n${read?.snippet ?? ""}`.trim(),
    });
  }
  return events;
}
