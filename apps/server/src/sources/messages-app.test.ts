import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toAppleNs } from "./imessage";
import { messagesAppSend } from "./messages-app";

const GOOD = { code: 0, killed: null, stderr: "" };

/** A chat.db of made-up chats: two services share the handle +15550100, the iMessage one has the newer message. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "messages-app-"));
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.run(`create table message (ROWID integer primary key, guid text, date integer, is_from_me integer, text text,
    attributedBody blob, error integer default 0, is_sent integer default 0)`);
  db.run(
    "create table chat (ROWID integer primary key, guid text, chat_identifier text)"
  );
  db.run(
    "create table chat_message_join (chat_id integer, message_id integer)"
  );
  db.run(
    "create table attachment (ROWID integer primary key, transfer_name text)"
  );
  db.run(
    "create table message_attachment_join (message_id integer, attachment_id integer)"
  );
  db.run("insert into chat values (1, 'SMS;-;+15550100', '+15550100')");
  db.run("insert into chat values (2, 'iMessage;-;+15550100', '+15550100')");
  db.run("insert into chat values (3, null, 'ana@example.com')");
  const old = toAppleNs(new Date("2026-01-01T00:00:00Z"));
  db.run("insert into message values (1, 'old-sms', ?, 0, 'hi', null, 0, 1)", [
    old - 5n,
  ]);
  db.run("insert into message values (2, 'old-im', ?, 1, 'ok', null, 0, 1)", [
    old,
  ]);
  db.run("insert into chat_message_join values (1, 1), (2, 2)");
  return { db, dir, path };
}

/** Messages as the test plays it: after osascript runs, the row it would have written appears in chat 2. */
function messages(
  f: ReturnType<typeof fixture>,
  row?: {
    error?: number;
    file?: string;
    // What Messages does a moment later: it marks the row sent, or sets an error.
    later?: { error?: number; sent?: number };
    sent?: number;
    text?: string;
  }
) {
  const calls: string[][] = [];
  const run = (cmd: string[]) => {
    calls.push(cmd);
    if (row) {
      const id = 10 + calls.length;
      f.db.run("insert into message values (?, ?, ?, 1, ?, null, ?, ?)", [
        id,
        `new-${id}`,
        toAppleNs(new Date(Date.now() + 1000)),
        row.text ?? "",
        row.error ?? 0,
        row.sent ?? 1,
      ]);
      if (row.later) {
        const { later } = row;
        setTimeout(
          () =>
            f.db.run(
              "update message set error = ?, is_sent = ? where ROWID = ?",
              [later.error ?? 0, later.sent ?? 0, id]
            ),
          60
        );
      }
      f.db.run("insert into chat_message_join values (2, ?)", [id]);
      if (row.file) {
        f.db.run("insert into attachment values (?, ?)", [id, row.file]);
        f.db.run("insert into message_attachment_join values (?, ?)", [id, id]);
      }
    }
    return Promise.resolve(GOOD);
  };
  return { calls, run };
}

const path = (
  f: ReturnType<typeof fixture>,
  run: ReturnType<typeof messages>["run"],
  staging?: string
) => messagesAppSend({ confirmMs: 400, db: f.path, pollMs: 20, run, staging });

test("holds: only chats with a guid; block: readable chat.db", async () => {
  const f = fixture();
  const p = path(f, messages(f).run);
  expect(p.holds(["+15550100", "ana@example.com", "+15550199"])).toEqual([
    "+15550100",
  ]);
  expect(await p.block()).toBeUndefined();
  expect(
    await messagesAppSend({ db: join(f.dir, "none.db") }).block()
  ).toContain("Full Disk Access");
});

test("text goes into the newest chat of a handle, as argv only, and the matching row confirms", async () => {
  const f = fixture();
  const m = messages(f, { text: 'say "hi"; rm -rf /' });
  const id = await path(f, m.run).send(
    { chat: "+15550100", text: 'say "hi"; rm -rf /' },
    "t"
  );
  expect(id).toBe("imessage:new-11");
  expect(m.calls[0]?.slice(-2)).toEqual([
    "iMessage;-;+15550100",
    'say "hi"; rm -rf /',
  ]);
  expect(m.calls[0]?.[0]).toBe("osascript");
});

test("a row of mine with other text does not confirm; none in time may have gone", async () => {
  const f = fixture();
  await expect(
    path(f, messages(f, { text: "something else" }).run).send(
      { chat: "+15550100", text: "hello" },
      "t"
    )
  ).rejects.toThrow("may have gone");
  await expect(
    path(f, messages(f).run).send({ chat: "+15550100", text: "hello" }, "t")
  ).rejects.toThrow("may have gone");
});

test("an error row is not sent", async () => {
  const f = fixture();
  await expect(
    path(f, messages(f, { error: 22, text: "hello" }).run).send(
      { chat: "+15550100", text: "hello" },
      "t"
    )
  ).rejects.toThrow("not sent: Messages reports error 22");
});

test("a file is staged, sent first, confirmed by its name, and removed; then the text", async () => {
  const f = fixture();
  const staging = join(f.dir, "staging");
  const seen: string[] = [];
  const m = messages(f, { file: "a.png", text: "caption" });
  const run = (cmd: string[]) => {
    // The staged file is there while Messages reads it.
    seen.push(existsSync(cmd.at(-1) as string) ? "there" : "missing");
    return m.run(cmd);
  };
  // The second call's row has the text, not a file: play both rows from one stub.
  const p = path(f, run, staging);
  await expect(
    p.send(
      {
        chat: "+15550100",
        file: {
          bytes: new Uint8Array([1, 2]),
          mime: "image/png",
          name: "a.png",
        },
        text: "caption",
      },
      "t"
    )
  ).resolves.toStartWith("imessage:new-");
  expect(seen[0]).toBe("there");
  expect(m.calls).toHaveLength(2);
  expect(m.calls[0]?.[4]).toContain("POSIX file");
  expect(readdirSync(staging)).toEqual([]);
});

test("a reply, a reaction and mentions are refused; osascript failure is not sent, -1743 names the grant", async () => {
  const f = fixture();
  const p = path(f, () =>
    Promise.resolve({ code: 1, killed: null, stderr: "Not authorized (-1743)" })
  );
  const refused = await Promise.all(
    [
      { chat: "+15550100", onMessage: "imessage:g", text: "x" },
      { chat: "+15550100", onMessage: "imessage:g", reaction: "👍" },
      {
        chat: "+15550100",
        mentions: [{ name: "Ana", sender: "ana@example.com" }],
        text: "@Ana",
      },
    ].map((d) => p.refusal(d))
  );
  for (const r of refused) {
    expect(r).toContain("text and one file");
  }
  expect(await p.refusal({ chat: "+15550100", text: "x" })).toBeUndefined();
  await expect(p.send({ chat: "+15550100", text: "x" }, "t")).rejects.toThrow(
    "not sent: Not authorized (-1743) (allow Life to control Messages: System Settings → Privacy & Security → Automation → Life → Messages)"
  );
});

test("a row not yet sent waits: then sent confirms, then an error is not sent, never marked may have gone", async () => {
  const f = fixture();
  const d = { chat: "+15550100", text: "hello" };
  await expect(
    path(
      f,
      messages(f, { later: { sent: 1 }, sent: 0, text: "hello" }).run
    ).send(d, "t")
  ).resolves.toStartWith("imessage:new-");
  const g = fixture();
  await expect(
    path(
      g,
      messages(g, { later: { error: 5 }, sent: 0, text: "hello" }).run
    ).send(d, "t")
  ).rejects.toThrow("not sent: Messages reports error 5");
  const h = fixture();
  await expect(
    path(h, messages(h, { sent: 0, text: "hello" }).run).send(d, "t")
  ).rejects.toThrow("may have gone");
});

test("after a file, a failed text says it was not sent, or may have gone", async () => {
  const file = { bytes: new Uint8Array([1]), mime: "image/png", name: "a.png" };
  const d = { chat: "+15550100", file, text: "hello" };
  const f = fixture();
  const m = messages(f, { file: "a.png", text: "" });
  const failing = (cmd: string[]) =>
    m.calls.length === 0
      ? m.run(cmd)
      : Promise.resolve({ code: 1, killed: null, stderr: "boom" });
  await expect(path(f, failing, join(f.dir, "s")).send(d, "t")).rejects.toThrow(
    "the file was sent, the text was not sent"
  );
  const g = fixture();
  const k = messages(g, { file: "a.png", text: "" });
  const silent = (cmd: string[]) =>
    k.calls.length === 0 ? k.run(cmd) : Promise.resolve({ ...GOOD, code: 0 });
  await expect(path(g, silent, join(g.dir, "s")).send(d, "t")).rejects.toThrow(
    "the text may have gone"
  );
});
