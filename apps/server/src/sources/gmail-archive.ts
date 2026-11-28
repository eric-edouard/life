import type { Database, SQLQueryBindings } from "bun:sqlite";
import { clock, DAY, HOUR, iso, MIN } from "../core/clock";
import { type GoogleAccount, gogCall, readGoogleAccounts } from "../core/gog";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { exec } from "../core/proc";
import { openReadOnly } from "../core/sqlite";
import type { SourceEvent, SourceFile } from "../records/source";
import {
  ARCHIVE,
  archiveDb,
  incomingArchived,
  insertAll,
  matrixArchive,
  newestArchived,
  openArchive,
  type Row,
  readArchived,
} from "./archived";
import { isToSelf, ownWordsOf, readMailAddresses } from "./mail";

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
/** Pages of newer mail a pass reads at most, after a long sleep; the backlog left waits for the next pass. */
const LIVE_PAGES = 10;
/** gog's words for a message gone between its search and its get: skipped, never a failure. */
const GONE = /not found|404/i;
/** Ids a pass: a full page of the live step, a smaller one of the backfill so a backlog drains without flooding. */
const LIVE_MAX = 100;
const BACKFILL_MAX = 50;
/** A message older than this was backfilled, not received: no arrival (`incomingGmail`). */
const ARRIVAL_FOR = 24 * HOUR;

const SCHEMA = `${matrixArchive("account text not null, bulk integer not null default 0, recipients text,")};
  create table if not exists cursors (account text primary key, page text, done integer not null);
  create index if not exists messages_event on messages (eventId)`;

/** The archive's Gmail store, its tables made. */
export const openGmail = (dir = ARCHIVE) => openArchive(dir, "gmail", SCHEMA);

interface Part {
  body?: { attachmentId?: string; size?: number };
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
  historyId?: string;
  id: string;
  internalDate?: string | number;
  labelIds?: string[];
  payload?: { headers?: Header[]; mimeType?: string; parts?: Part[] };
  threadId: string;
}
/** `gog gmail get`'s answer: the decoded body, the headers it names, and the message itself. */
interface Got {
  body?: string;
  headers?: Record<string, string | undefined>;
  message: Message;
}
/** `gog gmail messages search --ids-only`'s answer. */
interface Page {
  messages?: { id: string; threadId?: string }[];
  nextPageToken?: string;
}
interface Run {
  code: number;
  killed: unknown;
  stderr: string;
  stdout: string;
}

/**
 * The accounts Gmail reads: those given, less the ones Apple Mail already reads while Mail is readable, so a mailbox
 * both see is never counted twice. Mail unreadable leaves them all.
 */
export function gmailAccountsRead(
  accounts: readonly string[],
  mailOf: () => string[] = readMailAddresses
): string[] {
  let mail: string[] = [];
  try {
    mail = mailOf();
  } catch (e) {
    log("source.read", { ...errorOf(e), ok: false, source: "gmail" });
  }
  const inMail = new Set(mail.map((a) => a.toLowerCase()));
  return [...new Set(accounts.map((a) => a.toLowerCase()))].filter(
    (a) => !inMail.has(a)
  );
}

/** Whether an account's grant carries Gmail: gog's own service name, or a full scope URL. */
const canRead = (a: GoogleAccount) =>
  a.services.includes("gmail") || a.scopes.some((s) => s.includes("gmail"));

/** The accounts Gmail copies: the ones gog still holds a working Gmail grant for, less those Apple Mail reads. */
const gmailAccounts = async () =>
  gmailAccountsRead(
    (await readGoogleAccounts())
      .filter((a) => a.valid && canRead(a))
      .map((a) => a.address)
  );

/** A message's headers by lower-cased name: the payload's, which carry List-Id and List-Unsubscribe. */
const headersOf = (m: Message) =>
  new Map(
    (m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
  );

/** The address between a display name's angle brackets (`Ana <ana@example.com>`). */
const IN_BRACKETS = /<([^>]+)>/;

/** The addresses a To, Cc or Bcc header holds, lower-cased, one a line (as Mail keeps its `recipients`). */
const addressesIn = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((a) => (IN_BRACKETS.exec(a)?.[1] ?? a).trim().toLowerCase())
    .filter(Boolean)
    .join("\n");

/** The one address a From header holds, lower-cased. */
const addressOf = (value: string) =>
  (IN_BRACKETS.exec(value)?.[1] ?? value).trim().toLowerCase();

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

/** A message's row in the archive and its files; none for a message whose date Life can't read. */
function madeOf(account: string, got: Got, seenAt: string) {
  const m = got.message;
  const h = headersOf(m);
  const header = (name: string) => got.headers?.[name] ?? h.get(name);
  const subject = header("subject") ?? "";
  const sender = addressOf(header("from") ?? "");
  const at = atOf(m, header("date"));
  if (!at) {
    return;
  }
  const files = filesOf(m.payload?.parts, m.id);
  return {
    files: files.length
      ? [[m.threadId, m.id, JSON.stringify(files)] as SQLQueryBindings[]]
      : [],
    row: [
      (header("message_id") ?? "").trim().replace(/^<|>$/g, "") || m.id,
      m.id,
      m.threadId,
      subject,
      sender,
      null,
      sender === account ? 1 : 0,
      at,
      `${subject}\n${ownWordsOf(got.body ?? "")}`.trim(),
      seenAt,
      account,
      h.has("list-id") || h.has("list-unsubscribe") ? 1 : 0,
      addressesIn(header("to")),
    ],
  };
}

/**
 * Stores each of `ids` the archive doesn't hold yet (`get` reads one message): how many were new. A message gone between
 * the search and its get is skipped; any other failure throws, so a revoked token pauses the account before its
 * backfill cursor moves past mail it never stored.
 */
async function insertNew(
  db: Database,
  account: string,
  ids: string[],
  get: (id: string) => Promise<Got>
) {
  const isStored = db.prepare<{ x: number }, [string, string]>(
    "select 1 as x from messages where eventId = ? and account = ? limit 1"
  );
  const seenAt = iso(clock().getTime());
  let added = 0;
  for (const id of new Set(ids)) {
    if (isStored.get(id, account)) {
      continue;
    }
    let got: Got;
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
    const made = madeOf(account, got, seenAt);
    if (made) {
      added += insertAll(db, INSERT, [made.row]);
      insertAll(db, FILE_INSERT, made.files);
    }
  }
  return added;
}

interface Options {
  /** The accounts Gmail copies, as `gmailAccountsRead` keeps them. */
  accounts?: () => string[] | Promise<string[]>;
  archive?: string;
  /** Runs gog (`gogCall`'s command line and environment); a test passes its own. */
  run?: (
    cmd: string[],
    o: { env: Record<string, string | undefined>; timeout: number }
  ) => Promise<Run>;
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
  accounts = gmailAccounts,
  run = (cmd, o) => exec(cmd, o),
}: Options = {}) {
  let next = 0;
  /** Per account: when it may be asked again, how long its pause is, and the error its passes throw meanwhile. */
  const states = new Map<string, { at: number; error?: Error; wait: number }>();
  /** gog's answer to a Gmail read, never a write (`--readonly`). */
  const read = async <T = Page>(
    account: string,
    args: string[]
  ): Promise<T> => {
    const [cmd, { env }] = gogCall("gmail", account, [...args, "--readonly"]);
    const r = await run(cmd, { env, timeout: CALL_MS });
    if (r.killed || r.code !== 0) {
      throw new Error(
        `gog gmail ${r.killed ? "didn't answer" : `failed: ${r.stderr.trim().slice(-200)}`}`
      );
    }
    return JSON.parse(r.stdout.trim() || "{}") as T;
  };
  /** One account's newer mail, then its next page of backfill: how many messages were new. */
  const copyAccount = async (db: Database, account: string) => {
    const get = (id: string) => read<Got>(account, ["get", id]);
    const newest = db
      .query<{ at: string | null }, [string]>(
        "select max(at) as at from messages where account = ?"
      )
      .get(account)?.at;
    const query = liveQueryOf(newest ?? undefined);
    // Newest first, page after page, until a page holds nothing new: the mail of a gap (a Mac asleep) is caught up.
    let added = 0;
    let livePage = "";
    for (let n = 0; n < LIVE_PAGES; n++) {
      // biome-ignore lint/performance/noAwaitInLoops: each page follows the one before
      const live = await read(account, [
        "messages",
        "search",
        query,
        `--max=${LIVE_MAX}`,
        "--ids-only",
        ...(livePage ? [`--page=${livePage}`] : []),
      ]);
      const fresh = await insertNew(
        db,
        account,
        (live.messages ?? []).map((m) => m.id),
        get
      );
      added += fresh;
      livePage = live.nextPageToken ?? "";
      if (!(fresh && livePage)) {
        break;
      }
    }
    const cursor = db
      .query<{ done: number; page: string | null }, [string]>(
        "select page, done from cursors where account = ?"
      )
      .get(account);
    if (cursor?.done) {
      return added;
    }
    const page = cursor?.page ?? "";
    const back = await read(account, [
      "messages",
      "search",
      BACKFILL_QUERY,
      `--max=${BACKFILL_MAX}`,
      "--ids-only",
      ...(page ? [`--page=${page}`] : []),
    ]);
    added += await insertNew(
      db,
      account,
      (back.messages ?? []).map((m) => m.id),
      get
    );
    const token = back.nextPageToken ?? "";
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

/** One row per message (Gmail's never change), with its files, its account and what marks it. */
const ROWS = `select m.id, m.chat, m.chatName, m.sender, m.fromMe, m.at, m.type, m.text, m.deleted,
    m.account, m.bulk, m.recipients, f.files
  from messages m
  left join files f on f.rowid = (select max(rowid) from files x
    where x.chat = m.chat and x.eventId = m.eventId)
  where m.at >= ?`;

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
 * Its mail since `since`, from the archive's copy, for the accounts Gmail reads (`gmailAccountsRead`): `bulk` from a
 * list header, his own mail to himself marked as his words to Life.
 */
export function readGmail(
  since: Date,
  archive = ARCHIVE,
  before?: Date
): SourceEvent[] {
  const accounts = accountsIn(archive);
  const kept = gmailAccountsRead(accounts);
  if (!kept.length) {
    return [];
  }
  const mine = new Set(accounts.map((a) => a.toLowerCase()));
  const only = kept.map((a) => `'${a.replaceAll("'", "''")}'`).join(",");
  return readArchived<GmailRow>(
    "gmail",
    `${ROWS} and m.account in (${only})`,
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

/** The rows first written from `from` on that arrived today: a backfilled old mail is no arrival. */
export function incomingGmail(from?: number, archive = ARCHIVE) {
  const { end, rows } = incomingArchived("gmail", "eventId", from, archive);
  const since = iso(clock().getTime() - ARRIVAL_FOR);
  return { end, rows: rows.filter((r) => r.at >= since) };
}
