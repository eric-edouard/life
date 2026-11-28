import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnly } from "../core/sqlite";
import { archiveDb, incomingArchived } from "./archived";
import { gmailCopier, readGmail, readGmailAccounts } from "./gmail-archive";

afterAll(() => setSystemTime());

const T0 = new Date("2026-11-19T10:00:00.000Z").getTime();
const HOUR_MS = 3600 * 1000;
const at = (s: number) => setSystemTime(new Date(T0 + s * 1000));
const ME = "me@example.com";
const EPOCH = new Date(0);
const dir = () => mkdtempSync(join(tmpdir(), "gmail-archive-"));
/** The live step's query (newer mail), as opposed to the backfill's. */
const LIVE_SEARCH = /^(newer_than|after:)/;
const ok = { code: 0, killed: null, stderr: "", stdout: "" };

interface Answer {
  [k: string]: unknown;
}

/** One `gog gmail get` answer for a made-up message: its headers, its own words, and the reply it quotes under them. */
function got(id: string, over: Answer = {}) {
  const headers: Answer = {
    from: "Ana <Ana@Example.com>",
    message_id: `<${id}.mid@mail.example.com>`,
    subject: "The invoice",
    to: ME,
    ...(over.headers as Answer),
  };
  return {
    body:
      over.body ??
      "It went out today.\n\nOn Monday, Ana wrote:\n> is it coming?",
    headers,
    message: {
      id,
      internalDate: String(over.internalDate ?? T0 - HOUR_MS),
      payload: {
        headers: Object.entries(headers).map(([name, value]) => ({
          name,
          value,
        })),
        parts: over.parts ?? [],
      },
      threadId: over.threadId ?? `th-${id}`,
    },
  };
}

/**
 * A made-up gog: `live` is each account's newer mail, `pages` its backfill pages by token (`""` the first), `messages`
 * each id's `get` answer, `dangling` the ids whose get fails. Every command line is kept.
 */
function fakeGog() {
  const calls: string[][] = [];
  const live = new Map<string, string[]>();
  /** A live search's pages by token, for a test whose gap takes more than one page. */
  const livePages = new Map<string, { ids: string[]; next?: string }>();
  const pages = new Map<string, { ids: string[]; next?: string }>();
  const messages = new Map<string, unknown>();
  const dangling = new Set<string>();
  const failing = new Set<string>();
  const run = (cmd: string[]) => {
    calls.push(cmd);
    const account = (cmd.find((a) => a.startsWith("--account=")) ?? "").slice(
      10
    );
    const args = cmd.slice(2, -3);
    if (failing.has(account)) {
      return Promise.resolve({ ...ok, code: 1, stderr: "invalid_grant" });
    }
    if (args[0] === "get") {
      const id = args[1] as string;
      return Promise.resolve(
        dangling.has(id)
          ? { ...ok, code: 1, stderr: "not found" }
          : { ...ok, stdout: JSON.stringify(messages.get(id) ?? {}) }
      );
    }
    const page = (args.find((a) => a.startsWith("--page=")) ?? "").slice(7);
    const asked = LIVE_SEARCH.test(args[2] ?? "")
      ? (livePages.get(`${account}|${page}`) ?? {
          ids: live.get(account) ?? [],
          next: undefined,
        })
      : (pages.get(`${account}|${page}`) ?? { ids: [], next: undefined });
    return Promise.resolve({
      ...ok,
      stdout: JSON.stringify({
        messages: asked.ids.map((id) => ({ id, threadId: `th-${id}` })),
        nextPageToken: asked.next,
      }),
    });
  };
  return {
    calls,
    dangling,
    failing,
    gets: () => calls.filter((c) => c[2] === "get"),
    live,
    livePages,
    messages,
    pages,
    run: run as never,
    searches: () => calls.filter((c) => c[2] === "messages"),
  };
}

test("the copier stores a message under its thread, its Message-ID as its id, and his files by name only", async () => {
  const g = fakeGog();
  g.live.set(ME, ["g1", "g2"]);
  g.messages.set("g1", got("g1"));
  g.messages.set(
    "g2",
    got("g2", {
      body: "Done.",
      headers: { from: ME, subject: "Re: The invoice", to: "ana@example.com" },
      parts: [
        {
          body: { attachmentId: "a1" },
          filename: "quote.pdf",
          mimeType: "application/pdf",
          partId: "2",
        },
        { parts: [{ mimeType: "text/plain" }] },
      ],
      threadId: "th-g1",
    })
  );
  const archive = dir();
  at(0);
  expect(
    await gmailCopier({ accounts: () => [ME], archive, run: g.run })()
  ).toBe(2);
  // Gmail is only ever read.
  expect(g.calls.every((c) => c.includes("--readonly"))).toBe(true);
  expect(g.searches()[0]?.slice(2, 7)).toEqual([
    "messages",
    "search",
    "newer_than:2d -in:drafts -in:spam",
    "--max=100",
    "--ids-only",
  ]);
  const when = new Date(T0 - HOUR_MS).toISOString();
  expect(
    readGmail(EPOCH, archive).map((e) => ({
      at: e.at,
      chat: e.chat,
      chatName: e.chatName,
      files: e.files,
      fromMe: e.fromMe,
      id: e.id,
      sender: e.sender,
      text: e.text,
    }))
  ).toEqual([
    {
      at: when,
      chat: "th-g1",
      chatName: "The invoice",
      files: [],
      fromMe: false,
      id: "gmail:th-g1/g1.mid@mail.example.com",
      sender: "ana@example.com",
      text: "The invoice\nIt went out today.",
    },
    {
      at: when,
      chat: "th-g1",
      chatName: "Re: The invoice",
      files: [
        { mime: "application/pdf", name: "quote.pdf", ref: "gmail:g2#2" },
      ],
      fromMe: true,
      id: "gmail:th-g1/g2.mid@mail.example.com",
      sender: "me",
      text: "Re: The invoice\nDone.",
    },
  ]);
});

test("a stored message is never got again, and a message gone from Gmail stays in the copy", async () => {
  const g = fakeGog();
  g.live.set(ME, ["g1"]);
  g.messages.set("g1", got("g1"));
  const archive = dir();
  const copy = gmailCopier({ accounts: () => [ME], archive, run: g.run });
  at(0);
  expect(await copy()).toBe(1);
  const asked = g.gets().length;
  at(120);
  expect(await copy()).toBe(0);
  expect(g.gets().length).toBe(asked);
  // Gmail no longer has g1: the copy keeps it, and g2 still lands after it.
  g.dangling.add("g1");
  g.live.set(ME, ["g1", "g2"]);
  g.messages.set("g2", got("g2"));
  at(240);
  expect(await copy()).toBe(1);
  expect(readGmail(EPOCH, archive).map((e) => e.id)).toEqual([
    "gmail:th-g1/g1.mid@mail.example.com",
    "gmail:th-g2/g2.mid@mail.example.com",
  ]);
});

test("the backfill walks the mailbox a page a pass, then is done for good", async () => {
  const g = fakeGog();
  g.pages.set(`${ME}|`, { ids: ["b"], next: "p2" });
  g.pages.set(`${ME}|p2`, { ids: ["c"] });
  g.messages.set("b", got("b"));
  g.messages.set("c", got("c"));
  const archive = dir();
  const copy = gmailCopier({ accounts: () => [ME], archive, run: g.run });
  at(0);
  expect(await copy()).toBe(1);
  at(120);
  expect(await copy()).toBe(1);
  at(240);
  expect(await copy()).toBe(0);
  const backfills = () =>
    g.searches().filter((c) => !LIVE_SEARCH.test(c[4] ?? ""));
  expect(backfills().map((c) => c.includes("--page=p2"))).toEqual([
    false,
    true,
  ]);
  // Done: only the newer mail is asked for any more.
  expect(backfills().length).toBe(2);
  expect(readGmail(EPOCH, archive).map((e) => e.chat)).toEqual([
    "th-b",
    "th-c",
  ]);
});

test("a second pass within the minute asks nothing; a failing account pauses on its own and says so meanwhile", async () => {
  const g = fakeGog();
  const other = "other@example.com";
  g.live.set(ME, ["g1"]);
  g.messages.set("g1", got("g1"));
  g.failing.add(other);
  const archive = dir();
  const copy = gmailCopier({
    accounts: () => [ME, other],
    archive,
    run: g.run,
  });
  at(0);
  await expect(copy()).rejects.toThrow("invalid_grant");
  // The account that answered was copied all the same.
  expect(readGmail(EPOCH, archive).length).toBe(1);
  const asked = g.calls.length;
  at(30);
  await expect(copy()).rejects.toThrow("invalid_grant");
  expect(g.calls.length).toBe(asked);
  // Healed: asked again once its minute is up, then no more until the next.
  g.failing.delete(other);
  at(60);
  expect(await copy()).toBe(0);
  expect(g.calls.length).toBeGreaterThan(asked);
  const healed = g.calls.length;
  at(61);
  expect(await copy()).toBe(0);
  expect(g.calls.length).toBe(healed);
});

test("bulk mail is the list header's, and a mail he sent only to himself is marked as his words to Life", async () => {
  const g = fakeGog();
  g.live.set(ME, ["g1", "g2"]);
  g.messages.set(
    "g1",
    got("g1", {
      body: "News",
      headers: {
        from: "list@club.example",
        "list-id": "<club>",
        subject: "Club",
        to: ME,
      },
    })
  );
  g.messages.set(
    "g2",
    got("g2", {
      body: "Note to Life",
      headers: { from: ME, subject: "Note", to: ME },
    })
  );
  const archive = dir();
  at(0);
  await gmailCopier({ accounts: () => [ME], archive, run: g.run })();
  expect(
    readGmail(EPOCH, archive).map((e) => [e.bulk, e.marked, e.fromMe])
  ).toEqual([
    [true, undefined, false],
    [undefined, true, true],
  ]);
});

test("an account Apple Mail already reads is left out, and none is when Mail can't be read", () => {
  expect(
    readGmailAccounts([ME, "Ana@Example.com"], () => ["ME@example.com"])
  ).toEqual(["ana@example.com"]);
  expect(readGmailAccounts([ME], () => ["ana@example.com"])).toEqual([ME]);
  // Mail unreadable: its reader gives none (and logs it once, where it reads it).
  expect(readGmailAccounts([ME], () => [])).toEqual([ME]);
});

test("a gap bigger than one page is copied whole in one pass", async () => {
  const g = fakeGog();
  const first = Array.from({ length: 100 }, (_, i) => `m${i}`);
  g.livePages.set(`${ME}|`, { ids: first, next: "p2" });
  g.livePages.set(`${ME}|p2`, { ids: ["late"] });
  for (const id of [...first, "late"]) {
    g.messages.set(id, got(id));
  }
  const archive = dir();
  at(0);
  expect(
    await gmailCopier({ accounts: () => [ME], archive, run: g.run })()
  ).toBe(101);
  expect(g.searches().some((c) => c.includes("--page=p2"))).toBe(true);
});

test("a mail the live step copies 30 hours late is an arrival; a backfilled one is not", async () => {
  const g = fakeGog();
  const incoming = () => incomingArchived("gmail", "eventId", 0, archive).rows;
  g.live.set(ME, ["g1"]);
  g.messages.set("g1", got("g1"));
  g.pages.set(`${ME}|`, { ids: ["old"] });
  g.messages.set("old", got("old", { internalDate: T0 - 3 * 24 * HOUR_MS }));
  const archive = dir();
  const copy = gmailCopier({ accounts: () => [ME], archive, run: g.run });
  at(0);
  expect(await copy()).toBe(2);
  // An account's first pass and the backfill write export rows: nothing they copy arrived.
  expect(incoming()).toEqual([]);
  // 30 hours old, copied by the newer-mail step: a new arrival all the same.
  g.live.set(ME, ["g1", "g2"]);
  g.messages.set("g2", got("g2", { internalDate: T0 - 30 * HOUR_MS }));
  at(120);
  expect(await copy()).toBe(1);
  expect(incoming().map((r) => r.id)).toEqual([
    "gmail:th-g2/g2.mid@mail.example.com",
  ]);
});

/** What the archive stores of each message, as the copy wrote it. */
function storedRows(archive: string) {
  const db = openReadOnly(archiveDb("gmail", archive));
  try {
    return db
      .query<
        {
          fromMe: number;
          recipients: string | null;
          senderName: string | null;
        },
        []
      >("select fromMe, recipients, senderName from messages order by rowid")
      .all();
  } finally {
    db.close();
  }
}

const OTHER = "other@example.com";

test("a mail from his other address reads as his, not as the account it was copied under", async () => {
  const g = fakeGog();
  g.live.set(ME, ["g1"]);
  g.live.set(OTHER, ["g0"]);
  g.messages.set("g1", got("g1", { headers: { from: `Me <${OTHER}>` } }));
  g.messages.set("g0", got("g0"));
  const archive = dir();
  at(0);
  await gmailCopier({ accounts: () => [ME, OTHER], archive, run: g.run })();
  expect(
    readGmail(EPOCH, archive)
      .map((e) => [e.id, e.fromMe, e.sender])
      .sort()
  ).toEqual([
    ["gmail:th-g0/g0.mid@mail.example.com", false, "ana@example.com"],
    ["gmail:th-g1/g1.mid@mail.example.com", true, "me"],
  ]);
});

test("recipients are To, Cc and Bcc one a line; a self-mail with someone else on it is no note to himself", async () => {
  const g = fakeGog();
  g.live.set(ME, ["g1", "g2"]);
  g.messages.set(
    "g1",
    got("g1", {
      headers: {
        bcc: "Bo <bo@example.com>",
        cc: "Ana <ana@example.com>",
        from: `Me <${ME}>`,
        to: `Me <${ME}>`,
      },
    })
  );
  // From the first account's own address, sent to itself alone: his words to Life.
  g.messages.set("g2", got("g2", { headers: { from: ME, to: ME } }));
  const archive = dir();
  at(0);
  await gmailCopier({ accounts: () => [ME], archive, run: g.run })();
  expect(readGmail(EPOCH, archive).map((e) => e.marked)).toEqual([
    undefined,
    true,
  ]);
  expect(storedRows(archive)).toEqual([
    {
      fromMe: 0,
      recipients: `${ME}\nana@example.com\nbo@example.com`,
      senderName: "Me",
    },
    { fromMe: 0, recipients: ME, senderName: null },
  ]);
});

test("a mail two accounts hold is read once", async () => {
  const g = fakeGog();
  g.live.set(ME, ["g1"]);
  g.live.set(OTHER, ["g0"]);
  g.messages.set("g1", got("g1"));
  g.messages.set("g0", got("g0"));
  const archive = dir();
  const copy = gmailCopier({
    accounts: () => [ME, OTHER],
    archive,
    run: g.run,
  });
  at(0);
  expect(await copy()).toBe(2);
  // The other account now sees the same message as newer mail: a second row, read once.
  g.live.set(OTHER, ["g0", "g1"]);
  at(120);
  expect(await copy()).toBe(1);
  expect(
    readGmail(EPOCH, archive)
      .map((e) => e.id)
      .sort()
  ).toEqual([
    "gmail:th-g0/g0.mid@mail.example.com",
    "gmail:th-g1/g1.mid@mail.example.com",
  ]);
});

test("a get that fails for any reason but a gone message pauses the account before its backfill cursor moves", async () => {
  const g = fakeGog();
  g.pages.set(`${ME}|`, { ids: ["b"], next: "p2" });
  const archive = dir();
  const copy = gmailCopier({ accounts: () => [ME], archive, run: g.run });
  const run = g.run as unknown as (cmd: string[]) => Promise<unknown>;
  // Searches answer, but every get is refused: the token was revoked between the two.
  const refusing = (cmd: string[]) =>
    cmd[2] === "get"
      ? Promise.resolve({ ...ok, code: 1, stderr: "invalid_grant" })
      : run(cmd);
  const refused = gmailCopier({
    accounts: () => [ME],
    archive,
    run: refusing as never,
  });
  at(0);
  await expect(refused()).rejects.toThrow("invalid_grant");
  // The next copier starts the backfill from its first page again: nothing was skipped.
  g.messages.set("b", got("b"));
  at(120);
  expect(await copy()).toBe(1);
  expect(g.searches().some((c) => c.includes("--page=p2"))).toBe(false);
});

test("a page of newer mail that is all gone never hides the older mail behind it", async () => {
  const g = fakeGog();
  g.livePages.set(`${ME}|`, { ids: ["gone1", "gone2"], next: "p2" });
  g.livePages.set(`${ME}|p2`, { ids: ["older"] });
  g.dangling.add("gone1");
  g.dangling.add("gone2");
  g.messages.set("older", got("older"));
  const archive = dir();
  at(0);
  await gmailCopier({ accounts: () => [ME], archive, run: g.run })();
  expect(readGmail(EPOCH, archive).map((e) => e.id)).toEqual([
    "gmail:th-older/older.mid@mail.example.com",
  ]);
});
