import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  emlxPart,
  incomingMail,
  mailAccounts,
  mailRoot,
  ownWordsOf,
  readMail,
  readSentMailDates,
} from "./mail";

const emlx = (message: string) => {
  const bytes = Buffer.from(message.replace(/\n/g, "\r\n"), "utf8");
  return Buffer.concat([
    Buffer.from(`${bytes.length}\n`),
    bytes,
    Buffer.from('<?xml version="1.0"?><plist><dict/></plist>'),
  ]);
};

const ALTERNATIVE = `From: Ana <ana@example.com>
Subject: Devis
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

Bonjour, voici le devis pour la cuisine. Ca co=C3=BBte 1 200 =E2=82=AC, livr=
=C3=A9 lundi.
--b1
Content-Type: text/html; charset="utf-8"

<p>HTML version</p>
--b1--
`;

const HTML_ONLY = `Subject: Receipt
Content-Type: multipart/mixed; boundary=outer

--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: TEXT/PLAIN
Content-Transfer-Encoding: BASE64

--inner
Content-Type: TEXT/HTML; charset=utf-8
Content-Transfer-Encoding: BASE64

${Buffer.from("<html><head><style>p{color:red}</style></head><body><p>Paid&nbsp;&amp; done</p><p>Thanks</p></body></html>").toString("base64")}
--inner--
--outer
Content-Type: application/zip
Content-Disposition: attachment; filename=a.zip
Content-Transfer-Encoding: base64

UEsDBA==
--outer--
`;

// A PDF inside the .emlx, a photo whose name is RFC 2047-encoded that a partial .emlx left out (Mail keeps it in its
// Attachments folder), and two names RFC 2231 wrote: percent-encoded, and split in two.
const WITH_FILES = `Subject: Plans
Content-Type: multipart/mixed; boundary="m"

--m
Content-Type: text/plain; charset="utf-8"

Les plans.
--m
Content-Type: application/pdf; name="plan.pdf"
Content-Disposition: attachment; filename="plan.pdf"
Content-Transfer-Encoding: base64

JVBERi0=
--m
Content-Type: image/jpeg; name="=?UTF-8?Q?vue_=C3=A9t=C3=A9.jpg?="
Content-Disposition: inline; filename="=?UTF-8?Q?vue_=C3=A9t=C3=A9.jpg?="
Content-Transfer-Encoding: base64

--m
Content-Type: application/octet-stream
Content-Disposition: attachment; filename*=utf-8''R%C3%A9cap%20Commande.pdf

%PDF
--m
Content-Type: application/pdf
Content-Disposition: attachment; filename*0="Devis_cuisine_";
 filename*1="final.pdf"

%PDF
--m--
`;

// Also: text/plain is preferred and quoted-printable decoded (Devis); an empty text/plain falls back to stripped base64 HTML.
test("readMail reads every account, dedupes, skips junk and drafts, and knows the owner", () => {
  const base = mkdtempSync(join(tmpdir(), "mail-"));
  const root = join(base, "V10");
  mkdirSync(join(root, "MailData"), { recursive: true });
  const db = new Database(join(root, "MailData", "Envelope Index"));
  db.run(`create table messages (ROWID integer primary key, global_message_id integer, sender integer,
            subject_prefix text, subject integer, date_received integer, mailbox integer,
            deleted integer default 0, conversation_id integer default 0,
            list_id_hash integer default 0, unsubscribe_type integer)`);
  db.run("create table subjects (ROWID integer primary key, subject text)");
  db.run(
    "create table addresses (ROWID integer primary key, address text, comment text)"
  );
  db.run("create table mailboxes (ROWID integer primary key, url text)");
  db.run("create table labels (message_id integer, mailbox_id integer)");
  db.run(
    "create table recipients (ROWID integer primary key, message integer, address integer, type integer, position integer)"
  );
  // His reply goes to his other address only: a mail to himself.
  db.run("insert into recipients values (1, 1003, 3, 0, 0)");
  db.run(
    "create table message_global_data (ROWID integer primary key, message_id_header text, model_category integer)"
  );
  const acct = "AAAA-1111";
  db.run(`insert into mailboxes values (1, 'imap://${acct}/INBOX'),
            (2, 'imap://${acct}/%5BGmail%5D/Sent%20Mail'), (3, 'imap://${acct}/Junk'),
            (4, 'imap://${acct}/%5BGmail%5D/All%20Mail'), (5, 'imap://${acct}/%5BGmail%5D/Brouillons'),
            (6, 'imap://${acct}/Consent%20forms'), (7, 'imap://${acct}/Messages%20envoy%C3%A9s'),
            (8, 'imap://${acct}/%C3%80%20envoyer')`);
  db.run("insert into subjects values (1, 'Devis'), (2, 'Big prize')");
  db.run(
    `insert into addresses values (1, 'Ana@Example.com', 'Ana'), (2, 'Me@Mine.test', ''),
      (3, 'Me@Other.test', ''), (4, 'Bo@Example.com', 'Bo')`
  );
  db.run(
    "insert into message_global_data values (10, '<abc@example.com>', 1), (11, null, null), (14, '<files@example.com>', 3)"
  );
  const t = Date.parse("2026-10-09T08:00:00Z") / 1000;
  db.run(`insert into messages values
            (1001, 10, 1, null, 1, ${t}, 1, 0, 7, 0, null),
            (1002, 10, 1, null, 1, ${t}, 4, 0, 7, 0, null),
            (1003, 11, 2, 'Re: ', 1, ${t + 60}, 4, 0, 7, 0, 2),
            (1004, 12, 1, null, 2, ${t + 120}, 3, 0, 8, 0, null),
            (5, 13, 1, null, 1, ${t - 864_000}, 1, 0, 9, 0, null),
            (1006, 14, 1, null, 2, ${t + 180}, 1, 0, 10, 0, null),
            (1007, 15, 1, null, 2, ${t + 240}, 1, 0, 11, 0, null),
            (1008, 16, 2, null, 1, ${t + 300}, 5, 0, 12, 0, null),
            (1009, 16, 2, null, 1, ${t + 300}, 4, 0, 12, 0, null),
            (6, 17, 1, null, 1, ${t - 864_000}, 6, 0, 13, 0, null),
            (7, 18, 3, null, 1, ${t - 864_000}, 7, 0, 14, 0, null),
            (8, 19, 4, null, 1, ${t - 864_000}, 8, 0, 15, 0, null)`);
  db.run("insert into labels values (1003, 2)");
  db.close();
  const dir = join(root, acct, "INBOX.mbox", "STORE", "Data", "1", "Messages");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "1001.emlx"), emlx(ALTERNATIVE));
  const sentDir = join(
    root,
    acct,
    "[Gmail].mbox",
    "All Mail.mbox",
    "STORE",
    "Data",
    "1",
    "Messages"
  );
  mkdirSync(sentDir, { recursive: true });
  writeFileSync(
    join(sentDir, "1003.emlx"),
    emlx("Date: Fri, 9 Oct 2026 15:01:00 +0700\n\n")
  );

  writeFileSync(join(dir, "1006.emlx"), emlx(WITH_FILES));
  writeFileSync(join(dir, "1007.partial.emlx"), emlx(HTML_ONLY));
  const saved = join(dir, "..", "Attachments", "1006", "3");
  mkdirSync(saved, { recursive: true });
  writeFileSync(join(saved, "vue été.jpg"), "bytes");

  expect(mailRoot(base)).toBe(root);
  // A sent box by a whole word of its name, accented or not: "Consent forms" and "À envoyer" are not.
  expect(mailAccounts(root, join(base, "none.sqlite"))).toEqual([
    { addresses: ["me@mine.test", "me@other.test"], id: acct, name: acct },
  ]);
  // A sender his Contacts hold is marked.
  const events = readMail(
    new Date("2026-10-08T00:00:00Z"),
    root,
    join(base, "none.sqlite"),
    new Map([["ana@example.com", "Ana"]])
  );
  expect(events.at(-1)?.text).toBe("Big prize\nPaid & done\nThanks");
  expect(
    readMail(
      new Date("2026-10-08T00:00:00Z"),
      root,
      join(base, "none.sqlite"),
      new Map(),
      new Date("2026-10-09T08:03:00Z")
    )
  ).toHaveLength(2);
  expect(
    readSentMailDates(
      new Date("2026-10-08T00:00:00Z"),
      new Date("2026-10-09T08:03:00Z"),
      root,
      join(base, "none.sqlite")
    )
  ).toEqual([{ date: "Fri, 9 Oct 2026 15:01:00 +0700" }]);
  writeFileSync(
    join(sentDir, "1003.emlx"),
    emlx("Date: Fri, 9 Oct 2026 10:01:00 +0200\n\n")
  );
  expect(
    readSentMailDates(
      new Date("2026-10-08T00:00:00Z"),
      new Date("2026-10-09T08:03:00Z"),
      root,
      join(base, "none.sqlite")
    )[0]?.date
  ).toBe("Fri, 9 Oct 2026 15:01:00 +0700");

  expect(events.slice(0, -1)).toEqual([
    {
      at: "2026-10-09T08:00:00.000Z",
      bulk: false,
      chat: "mail:7",
      chatName: "Devis",
      contact: true,
      files: [],
      fromMe: false,
      hasOwnerWrittenInThread: true,
      id: "mail:abc@example.com",
      sender: "ana@example.com",
      source: "mail",
      text: "Devis\nBonjour, voici le devis pour la cuisine. Ca coûte 1 200 €, livré lundi.",
      transaction: true,
    },
    {
      at: "2026-10-09T08:01:00.000Z",
      bulk: true,
      chat: "mail:7",
      chatName: "Devis",
      files: [],
      fromMe: true,
      hasOwnerWrittenInThread: true,
      id: "mail:11",
      marked: true,
      sender: "me@mine.test",
      source: "mail",
      text: "Re: Devis",
    },
    {
      at: "2026-10-09T08:03:00.000Z",
      bulk: false,
      chat: "mail:10",
      chatName: "Big prize",
      contact: true,
      files: [
        {
          mime: "application/pdf",
          name: "plan.pdf",
          path: join(dir, "1006.emlx"),
          ref: "mail:files@example.com#2",
        },
        {
          mime: "image/jpeg",
          name: "vue été.jpg",
          path: join(saved, "vue été.jpg"),
          ref: "mail:files@example.com#3",
        },
        {
          mime: "application/pdf",
          name: "Récap Commande.pdf",
          path: join(dir, "1006.emlx"),
          ref: "mail:files@example.com#4",
        },
        {
          mime: "application/pdf",
          name: "Devis_cuisine_final.pdf",
          path: join(dir, "1006.emlx"),
          ref: "mail:files@example.com#5",
        },
      ],
      fromMe: false,
      id: "mail:files@example.com",
      sender: "ana@example.com",
      source: "mail",
      text: "Big prize\nLes plans.",
    },
  ]);
  // Copied to anyone else, it is no longer a mail to himself.
  const again = new Database(join(root, "MailData", "Envelope Index"));
  again.run("insert into recipients values (2, 1003, 1, 1, 0)");
  again.close();
  expect(
    readMail(
      new Date("2026-10-08T00:00:00Z"),
      root,
      join(base, "none.sqlite")
    ).find((e) => e.id === "mail:11")?.marked
  ).toBeUndefined();
  // A file inside the .emlx is read back by its part number; a part that is not there is nothing.
  expect(
    emlxPart(join(dir, "1006.emlx"), "mail:files@example.com#2")?.toString()
  ).toBe("%PDF-");
  expect(
    emlxPart(join(dir, "1006.emlx"), "mail:files@example.com#9")
  ).toBeUndefined();
  // Each file is read once; a partial message is read again once Mail has it whole, under its own name.
  writeFileSync(join(dir, "1007.emlx"), emlx(ALTERNATIVE));
  expect(
    readMail(
      new Date("2026-10-08T00:00:00Z"),
      root,
      join(base, "none.sqlite"),
      new Map()
    ).at(-1)?.text
  ).toBe(
    "Big prize\nBonjour, voici le devis pour la cuisine. Ca coûte 1 200 €, livré lundi."
  );
  // A Mac that doesn't sort mail has no category: nothing is a transaction.
  const unsorted = new Database(join(root, "MailData", "Envelope Index"));
  unsorted.run("alter table message_global_data drop column model_category");
  unsorted.close();
  const plain = readMail(
    new Date("2026-10-08T00:00:00Z"),
    root,
    join(base, "none.sqlite"),
    new Map()
  );
  expect(plain.length).toBeGreaterThan(0);
  expect(plain.filter((e) => e.transaction)).toEqual([]);
  // What is new from a row on: a copy in another mailbox (All Mail) is the same message; ids are readMail's.
  const fresh = incomingMail(1001, root);
  expect(fresh.end).toBe(1010);
  expect(fresh.rows.map((r) => r.row)).toEqual([
    1001, 1003, 1004, 1006, 1007, 1008,
  ]);
  expect(events.some((e) => e.id === fresh.rows[0]?.id)).toBe(true);
});

test("a mail is its own words, whole: the history a reply quotes is left out, a forward kept", () => {
  const long = "word ".repeat(1000).trim();
  expect(ownWordsOf(long)).toBe(long);
  expect(
    ownWordsOf(
      "Yes, Tuesday works.\nOn Mon, 3 Nov 2026, Ana wrote:\nCan we meet?\n> earlier"
    )
  ).toBe("Yes, Tuesday works.");
  expect(
    ownWordsOf("Oui.\nLe lun. 3 nov. 2026, Ana a écrit :\nOn se voit ?")
  ).toBe("Oui.");
  expect(ownWordsOf("See below\n> quoted\nthanks")).toBe("See below\nthanks");
  const forward =
    "FYI\n---------- Forwarded message ---------\nFrom: Ana <ana@example.com>\nThe plan";
  expect(ownWordsOf(forward)).toBe(forward);
});

test("readMail flags a thread the owner wrote in on any day, never one holding only his unsent draft", () => {
  const base = mkdtempSync(join(tmpdir(), "mail-thread-"));
  const root = join(base, "V10");
  mkdirSync(join(root, "MailData"), { recursive: true });
  const db = new Database(join(root, "MailData", "Envelope Index"));
  db.run(`create table messages (ROWID integer primary key, global_message_id integer, sender integer,
            subject_prefix text, subject integer, date_received integer, mailbox integer,
            deleted integer default 0, conversation_id integer default 0,
            list_id_hash integer default 0, unsubscribe_type integer)`);
  db.run("create table subjects (ROWID integer primary key, subject text)");
  db.run(
    "create table addresses (ROWID integer primary key, address text, comment text)"
  );
  db.run("create table mailboxes (ROWID integer primary key, url text)");
  db.run("create table labels (message_id integer, mailbox_id integer)");
  db.run(
    "create table recipients (ROWID integer primary key, message integer, address integer, type integer, position integer)"
  );
  db.run(
    "create table message_global_data (ROWID integer primary key, message_id_header text, model_category integer)"
  );
  const acct = "BBBB-2222";
  db.run(`insert into mailboxes values (1, 'imap://${acct}/INBOX'),
            (2, 'imap://${acct}/Sent'), (3, 'imap://${acct}/Drafts')`);
  db.run("insert into subjects values (1, 'Trip')");
  db.run(
    "insert into addresses values (1, 'Eve@Example.test', ''), (2, 'Me@Mine.test', '')"
  );
  const day = 86_400;
  const t = Date.parse("2026-10-09T08:00:00Z") / 1000;
  // Thread 7: he wrote ten days before the window, Eve replies inside it. Thread 8: only his unsent draft before it.
  db.run(`insert into messages values
            (1, 1, 2, null, 1, ${t - 10 * day}, 2, 0, 7, 0, null),
            (2, 2, 1, null, 1, ${t}, 1, 0, 7, 0, null),
            (3, 3, 2, null, 1, ${t - 10 * day}, 3, 0, 8, 0, null),
            (4, 4, 1, null, 1, ${t}, 1, 0, 8, 0, null)`);
  db.close();
  const events = readMail(
    new Date("2026-10-08T00:00:00Z"),
    root,
    join(base, "none.sqlite"),
    new Map()
  );
  expect(
    events.map((e) => [e.chat, e.hasOwnerWrittenInThread ?? null])
  ).toEqual([
    ["mail:7", true],
    ["mail:8", null],
  ]);
});
