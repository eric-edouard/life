import type { Database, SQLQueryBindings } from "bun:sqlite";
import { clock, DAY, iso, MIN } from "../core/clock";
import {
  type GogRunner,
  gogJson,
  hasGrant,
  readGoogleAccounts,
} from "../core/gog";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent, SourceFile } from "../records/source";
import {
  ARCHIVE,
  archiveDb,
  insertAll,
  matrixArchive,
  newestArchived,
  openArchive,
  type Row,
  readArchived,
} from "./archived";
import { readOwnMailAddresses } from "./gmail";
import { isToSelf, ownWordsOf, readMailAddressesOrNone } from "./mail";

// The Gmail source: every account he signed in with Google (`readGoogleAccounts`) copied into `archive/gmail.sqlite` and
// read from there, never from Google. One row a message (Gmail's never change): its Message-ID is its id, so a reply
// finds it again (`rfc822msgid:`, gmail.ts), and its thread its chat. A message deleted in Gmail stays in the copy. The
// store is behind this module alone, so where the copy lives is a one-line change.

/** How often the copier asks Gmail: a new mail is there a minute later, well under its quota. */
const POLL_MS = MIN;
/** A failing account is asked again after a pause that doubles up to this. */
const PAUSE_MAX = 15 * MIN;
/** How long one gog call is given: a page of ids, or one message with its body. */
const CALL_MS = MIN;
/** The whole mailbox he backfills, and so his newer mail: never a draft, never spam. */
const BACKFILL_QUERY = "-in:drafts -in:spam";
/** His newer mail: from a day before the newest message kept (Gmail's `after:` takes seconds), else the last 2 days. */
const liveQueryOf = (newest: string | undefined) =>
  `${newest ? `after:${Math.floor((Date.parse(newest) - DAY) / 1000)}` : "newer_than:2d"} ${BACKFILL_QUERY}`;
/** gog's words for a message gone between its search and its get: skipped, never a failure. */
const GONE = /not found|404/i;
/** Ids a pass: a full page of the live step, a smaller one of the backfill so a backlog drains without flooding. */
const LIVE_MAX = 100;
const BACKFILL_MAX = 50;
/** The Gmail scope `connectGoogle` asks for (read and send): a grant carrying it is a mailbox Gmail copies. */
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail";

const SCHEMA = `${matrixArchive("account text not null, bulk integer not null default 0, recipients text,")};
  create table if not exists cursors (account text primary key, page text, done integer not null);
  create index if not exists messages_event on messages (eventId);
  create index if not exists messages_at on messages (at);
  create index if not exists messages_id on messages (id)`;

/** The archive's Gmail store, its tables made. */
const openGmail = (dir = ARCHIVE) => openArchive(dir, "gmail", SCHEMA);

interface Part {
  body?: { attachmentId?: string };
  filename?: string;
  mimeType?: string;
  partId?: string;
  parts?: Part[];
}
interface Header {
  name: string;
  value: string;
}
interface Message {
  id: string;
  internalDate?: string | number;
  payload?: { headers?: Header[]; mimeType?: string; parts?: Part[] };
  threadId: string;
}
/** `gog gmail get`'s answer: the decoded body, the headers it names, and the message itself. */
interface GmailMessage {
  body?: string;
  headers?: Record<string, string | undefined>;
  message: Message;
}
/** `gog gmail messages search --ids-only`'s answer. */
interface Page {
  messages?: { id: string; threadId?: string }[];
  nextPageToken?: string;
}

/**
 * The accounts Gmail reads, of those given: less the ones Apple Mail already reads while Mail is readable, so a mailbox
 * both see is never counted twice. Mail unreadable leaves them all.
 */
export function readGmailAccounts(
  accounts: readonly string[],
  mailOf: () => string[] = readMailAddressesOrNone
): string[] {
  const inMail = new Set(mailOf().map((a) => a.toLowerCase()));
  return [...new Set(accounts.map((a) => a.toLowerCase()))].filter(
    (a) => !inMail.has(a)
  );
}

/** The accounts the copier copies: those gog holds a working Gmail grant for, less those Apple Mail reads. */
const signedInGmailAccounts = async () =>
  readGmailAccounts(
    (await readGoogleAccounts())
      .filter((a) => hasGrant(a, GMAIL_SCOPE))
      .map((a) => a.address)
  );

/** A message's headers by lower-cased name: the payload's, which carry List-Id and List-Unsubscribe. */
const headersOf = (m: Message) =>
  new Map(
    (m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
  );

/** The address between a display name's angle brackets (`Ana <ana@example.com>`). */
const IN_BRACKETS = /<([^>]+)>/;

/** The addresses To, Cc and Bcc hold, lower-cased, one a line (as Mail keeps its `recipients`). */
const recipientsOf = (...headers: (string | undefined)[]) =>
  headers
    .flatMap((value) => (value ?? "").split(","))
    .map((a) => (IN_BRACKETS.exec(a)?.[1] ?? a).trim().toLowerCase())
    .filter(Boolean)
    .join("\n");

/** The one address a From header holds, lower-cased. */
const addressOf = (value: string) =>
  (IN_BRACKETS.exec(value)?.[1] ?? value).trim().toLowerCase();

/** The display name a From header gives (`Ana <ana@example.com>` is Ana), unquoted; none for a bare address. */
const displayNameOf = (value: string) => {
  const at = value.search(IN_BRACKETS);
  return (
    (at > 0 ? value.slice(0, at) : "").trim().replace(/^"|"$/g, "") || null
  );
};

/** When Gmail says the message is, else its Date header; none when neither is a time. */
function atOf(m: Message, date: string | undefined) {
  const sent = Number(m.internalDate);
  const ms = sent > 0 ? sent : Date.parse(date ?? "");
  return Number.isFinite(ms) ? iso(ms) : undefined;
}

/**
 * The files a message carries, by name: their bytes stay on Google's side and are got on demand later. A part with a
 * file name is a file; a part without one holds its own (`multipart/*`).
 */
function filesOf(parts: Part[] | undefined, id: string): SourceFile[] {
  return (parts ?? []).flatMap((p) => [
    ...(p.filename
      ? [
          {
            mime: p.mimeType ?? "application/octet-stream",
            name: p.filename,
            ref: `gmail:${id}#${p.partId ?? p.filename}`,
          },
        ]
      : []),
    ...filesOf(p.parts, id),
  ]);
}

const INSERT = `insert or ignore into messages
  (id, eventId, chat, chatName, sender, senderName, fromMe, at, type, text, deleted, seenAt, account, bulk, recipients)
  values (?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, 0, ?, ?, ?, ?)`;
const FILE_INSERT =
  "insert or ignore into files (chat, eventId, files) values (?, ?, ?)";

/**
 * A message's row in the archive and its files; none for a message whose date Life can't read. `isExport` writes it as
 * an export row (an old mail a backfill copied, or one an account's first pass copied), which is no arrival.
 * `fromMe` is stored 0, the column being required: the read decides it from his own addresses.
 */
function archivedRowOf(
  account: string,
  got: GmailMessage,
  seenAt: string,
  isExport: boolean
) {
  const m = got.message;
  const h = headersOf(m);
  const header = (name: string) => got.headers?.[name] ?? h.get(name);
  const subject = header("subject") ?? "";
  const from = header("from") ?? "";
  const at = atOf(m, header("date"));
  if (!at) {
    return;
  }
  const eventId = isExport ? `export:${m.id}` : m.id;
  const files = filesOf(m.payload?.parts, m.id);
  return {
    files: files.length
      ? [[m.threadId, eventId, JSON.stringify(files)] as SQLQueryBindings[]]
      : [],
    row: [
      (header("message_id") ?? "").trim().replace(/^<|>$/g, "") || m.id,
      eventId,
      m.threadId,
      subject,
      addressOf(from),
      displayNameOf(from),
      0,
      at,
      `${subject}\n${ownWordsOf(got.body ?? "")}`.trim(),
      seenAt,
      account,
      h.has("list-id") || h.has("list-unsubscribe") ? 1 : 0,
      recipientsOf(header("to"), header("cc"), header("bcc")),
    ],
  };
}

/**
 * Stores each of `ids` the archive doesn't hold yet for `account` (`get` reads one message): how many were new. A
 * message gone between the search and its get is skipped; any other failure throws, so a revoked token pauses the
 * account before its backfill cursor moves past mail it never stored. `isExport` writes them as export rows.
 */
async function insertNew(
  db: Database,
  account: string,
  ids: string[],
  get: (id: string) => Promise<GmailMessage>,
  isExport: boolean
) {
  // A message may be stored as an arrival or as an export row: already stored is either.
  const isStored = db.prepare<{ x: number }, [string, string, string]>(
    "select 1 as x from messages where eventId in (?, ?) and account = ? limit 1"
  );
  const seenAt = iso(clock().getTime());
  let added = 0;
  for (const id of new Set(ids)) {
    if (isStored.get(id, `export:${id}`, account)) {
      continue;
    }
    let got: GmailMessage;
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one get a message, one gog at a time
      got = await get(id);
    } catch (e) {
      if (!GONE.test((e as Error).message)) {
        throw e;
      }
      log("source.read", { ...errorOf(e), ok: false, source: "gmail" });
      continue;
    }
    const made = archivedRowOf(account, got, seenAt, isExport);
    if (made) {
      added += insertAll(db, INSERT, [made.row]);
      insertAll(db, FILE_INSERT, made.files);
    }
  }
  return added;
}

interface Options {
  /** The accounts Gmail copies, as `readGmailAccounts` keeps them. */
  accounts?: () => string[] | Promise<string[]>;
  archive?: string;
  /** How gog is run; a test passes its own (`gogJson`'s own default runs it for real). */
  run?: GogRunner;
}

/**
 * The copier of Gmail into the archive (`AppStore.copy`): at most one pass a minute. Each account's newer mail first,
 * then one page further back through its mailbox until that cursor is done (Gmail searches newest first and its page
 * token walks back), so an old mailbox fills in without flooding. A failing account pauses on its own, a minute
 * doubling to 15, and its error is thrown on each pass of that pause, so a revoked token never stops the other
 * accounts and the archive's incident stays open.
 * ponytail: one get per message; batch gets if the backfill is too slow.
 */
export function gmailCopier({
  archive = ARCHIVE,
  accounts = signedInGmailAccounts,
  run,
}: Options = {}) {
  let next = 0;
  /** Per account: when it may be asked again, how long its pause is, and the error its passes throw meanwhile. */
  const states = new Map<string, { at: number; error?: Error; wait: number }>();
  /** gog's answer to a Gmail read, never a write (`--readonly`). */
  const read = <T = Page>(account: string, args: string[]) =>
    gogJson<T>("gmail", account, [...args, "--readonly"], run, CALL_MS);
  /** One page of a search's ids: `page` the token to start from (none: the first). */
  const searchIds = async (
    account: string,
    query: string,
    max: number,
    page: string
  ) => {
    const r = await read(account, [
      "messages",
      "search",
      query,
      `--max=${max}`,
      "--ids-only",
      ...(page ? [`--page=${page}`] : []),
    ]);
    return {
      ids: (r.messages ?? []).map((m) => m.id),
      next: r.nextPageToken ?? "",
    };
  };
  /**
   * One account's newer mail, newest first, page after page until a page holds nothing new or there is no next page:
   * a gap (a Mac asleep, a long pause) is caught up in one pass.
   */
  const copyNewer = async (
    db: Database,
    account: string,
    get: (id: string) => Promise<GmailMessage>,
    isExport: boolean
  ) => {
    const newest = db
      .query<{ at: string | null }, [string]>(
        "select max(at) as at from messages where account = ?"
      )
      .get(account)?.at;
    const query = liveQueryOf(newest ?? undefined);
    let added = 0;
    let page = "";
    let fresh: number;
    do {
      // biome-ignore lint/performance/noAwaitInLoops: each page follows the one before
      const found = await searchIds(account, query, LIVE_MAX, page);
      fresh = await insertNew(db, account, found.ids, get, isExport);
      added += fresh;
      page = found.next;
    } while (fresh && page);
    return added;
  };
  /** One account's newer mail, then its next page of backfill: how many messages were new. */
  const copyAccount = async (db: Database, account: string) => {
    const get = (id: string) => read<GmailMessage>(account, ["get", id]);
    // An account the archive holds no row of is being backfilled: nothing this pass writes arrived.
    const isFirstPass = !db
      .query<{ x: number }, [string]>(
        "select 1 as x from messages where account = ? limit 1"
      )
      .get(account);
    let added = await copyNewer(db, account, get, isFirstPass);
    const cursor = db
      .query<{ done: number; page: string | null }, [string]>(
        "select page, done from cursors where account = ?"
      )
      .get(account);
    if (cursor?.done) {
      return added;
    }
    const page = cursor?.page ?? "";
    const back = await searchIds(account, BACKFILL_QUERY, BACKFILL_MAX, page);
    added += await insertNew(db, account, back.ids, get, true);
    const token = back.next;
    // A page token that doesn't move would walk the same page forever: the mailbox is done.
    const done = !token || token === page ? 1 : 0;
    db.run(
      `insert into cursors (account, page, done) values (?, ?, ?)
        on conflict (account) do update set page = excluded.page, done = excluded.done`,
      [account, token, done]
    );
    return added;
  };
  /**
   * One account this pass: its new mail, or, while its pause holds, the error kept for the pass's end (and none: it
   * waits). A failure doubles its own pause; the others are asked all the same.
   */
  const copyInTurn = async (
    db: Database,
    account: string,
    now: number,
    failures: Error[]
  ) => {
    const state = states.get(account) ?? { at: 0, wait: 0 };
    states.set(account, state);
    if (now < state.at) {
      if (state.error) {
        failures.push(state.error);
      }
      return 0;
    }
    try {
      const added = await copyAccount(db, account);
      state.wait = 0;
      state.error = undefined;
      state.at = 0;
      return added;
    } catch (e) {
      state.wait = Math.min(state.wait ? state.wait * 2 : POLL_MS, PAUSE_MAX);
      state.error = e as Error;
      state.at = now + state.wait;
      failures.push(state.error);
      return 0;
    }
  };
  return async () => {
    const now = clock().getTime();
    if (now < next) {
      // A paused account's failure stays the archive's incident until it heals (as GitHub's).
      const error = [...states.values()].find((s) => s.error)?.error;
      if (error) {
        throw error;
      }
      return 0;
    }
    next = now + POLL_MS;
    const list = await accounts();
    if (!list.length) {
      return 0;
    }
    const failures: Error[] = [];
    const db = openGmail(archive);
    let added = 0;
    try {
      for (const account of list) {
        // biome-ignore lint/performance/noAwaitInLoops: one account after another, one gog at a time
        added += await copyInTurn(db, account, now, failures);
      }
    } finally {
      db.close();
    }
    if (failures.length) {
      throw failures[0];
    }
    return added;
  };
}

/** The archive's copier: one for the process, so its pauses and cursors hold across passes. */
export const copyGmail = gmailCopier();

/** One message's stored row, as `readGmail` reads it. */
interface GmailRow extends Row {
  account: string;
  bulk: number;
  files: string | null;
  recipients: string | null;
}

/** Addresses as SQL text literals, escaped. */
const sqlTextOf = (values: string[]) =>
  values.map((v) => `'${v.replaceAll("'", "''")}'`).join(",");

/**
 * One row per message (Gmail's never change), with its files, its account and what marks it: `fromMe` from whether the
 * sender is one of `mine`, and of a message two accounts hold, its first row alone.
 */
const rowsSql = (mine: string[]) => `select m.id, m.chat, m.chatName, m.sender,
    coalesce(m.sender in (${sqlTextOf(mine)}), 0) as fromMe,
    m.at, m.type, m.text, m.deleted, m.account, m.bulk, m.recipients, f.files
  from messages m
  left join files f on f.rowid = (select max(rowid) from files x
    where x.chat = m.chat and x.eventId = m.eventId)
  where m.at >= ?
    and m.rowid = (select min(x.rowid) from messages x where x.id = m.id)`;

/** The accounts the archive holds a message of. */
function accountsIn(archive: string) {
  const db = openReadOnly(archiveDb("gmail", archive));
  try {
    return db
      .query<{ account: string }, []>("select distinct account from messages")
      .all()
      .map((r) => r.account);
  } finally {
    db.close();
  }
}

/**
 * Its mail since `since`, from the archive's copy, for the accounts Gmail reads (`readGmailAccounts`): `bulk` from a
 * list header, his own mail to himself marked as his words to Life. Whether he wrote a message is his own addresses'
 * (Mail's, gog's, and the accounts the copy holds), not the account it was copied under.
 */
export function readGmail(
  since: Date,
  archive = ARCHIVE,
  before?: Date
): SourceEvent[] {
  const accounts = accountsIn(archive);
  const kept = readGmailAccounts(accounts);
  if (!kept.length) {
    return [];
  }
  const mine = new Set(
    [...readOwnMailAddresses(), ...accounts].map((a) => a.toLowerCase())
  );
  const only = sqlTextOf(kept);
  return readArchived<GmailRow>(
    "gmail",
    `${rowsSql([...mine])} and m.account in (${only})`,
    since,
    archive,
    (raw) => raw,
    (r) => ({
      files: JSON.parse(r.files ?? "[]") as SourceFile[],
      ...(r.bulk ? { bulk: true } : {}),
      ...(isToSelf(r.sender ?? "", r.recipients, mine)
        ? { marked: true as const }
        : {}),
    }),
    before
  );
}

/** Its newest message, for its card. */
export const newestGmail = () =>
  newestArchived(
    "gmail",
    "select m.at, m.chatName || ': ' || m.text as words from messages m order by m.at desc limit 1"
  );
