import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isMessageFile,
  mbsyncConfig,
  newestMaildir,
  readMaildir,
} from "./imap";
import { messagePart } from "./mail";

const at = (iso: string) => new Date(iso);
// Two messages came last at once: either is the newest.
const NEWEST = /: (Not sent|Big prize)$/;

/** A message mbsync wrote into `folder`, received at `iso` (mbsync sets the file's time), with its flags. */
function put(
  root: string,
  folder: string,
  name: string,
  iso: string,
  text: string
) {
  const dir = join(root, folder, "cur");
  mkdirSync(join(root, folder, "new"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, text);
  utimesSync(path, at(iso), at(iso));
  return path;
}

test("mbsync mirrors every folder but junk, trash and drafts, or the ones set, the password from the environment", () => {
  const config = mbsyncConfig(
    { host: "imap.example.com", port: 993, user: "me@mine.test" },
    "/copy"
  );
  expect(config).toContain('PassCmd "printenv LIFE_IMAP_PASSWORD"');
  expect(config).toContain("TLSType IMAPS");
  expect(config).toContain('Patterns "*" "!*junk*" "!*Junk*"');
  expect(config).toContain("Sync Pull");
  // Dated by when the server received it, never by when it was copied.
  expect(config).toContain("CopyArrivalDate yes");
  expect(
    mbsyncConfig(
      { folders: ["[Gmail]/All Mail"], host: "h", port: 143, user: "u" },
      "/copy"
    )
  ).toContain("TLSType STARTTLS\n");
});

test("readMaildir reads the copy as Mail's store: once each, threads, drafts and junk skipped, his own known", () => {
  const root = mkdtempSync(join(tmpdir(), "maildir-"));
  put(
    root,
    "INBOX",
    "1.M1P1.host,U=1:2,S",
    "2026-10-09T08:00:00Z",
    `From: Ana <Ana@Example.com>
Subject: Devis
Message-ID: <abc@example.com>
Content-Type: text/plain; charset=utf-8

Bonjour, voici le devis.
`
  );
  // The same message under another label (Gmail mirrors each), read once.
  put(
    root,
    "[Gmail]/All Mail",
    "2.M2P1.host,U=7:2,S",
    "2026-10-09T08:00:00Z",
    "From: Ana <ana@example.com>\nSubject: Devis\nMessage-ID: <abc@example.com>\n\nBonjour, voici le devis.\n"
  );
  const files = put(
    root,
    "[Gmail]/Sent Mail",
    "3.M3P1.host,U=2:2,S",
    "2026-10-09T08:01:00Z",
    `From: Me <me@mine.test>
Subject: Re: Devis
Message-ID: <reply@mine.test>
In-Reply-To: <abc@example.com>
References: <abc@example.com>
Content-Type: multipart/mixed; boundary="m"

--m
Content-Type: text/plain

OK pour lundi.
--m
Content-Type: application/pdf; name="plan.pdf"
Content-Disposition: attachment; filename="plan.pdf"
Content-Transfer-Encoding: base64

JVBERi0=
--m--
`
  );
  // A draft by its flag, junk by its folder, and one received before the window.
  put(
    root,
    "[Gmail]/All Mail",
    "4.M4P1.host,U=8:2,DS",
    "2026-10-09T09:00:00Z",
    "From: me@mine.test\nSubject: Not sent\nMessage-ID: <draft@mine.test>\n\nunsent\n"
  );
  put(
    root,
    "Junk",
    "5.M5P1.host,U=1:2,",
    "2026-10-09T09:00:00Z",
    "From: x@spam.test\nSubject: Big prize\nMessage-ID: <spam@spam.test>\n\nwin\n"
  );
  put(
    root,
    "INBOX",
    "6.M6P1.host,U=3:2,S",
    "2026-10-01T09:00:00Z",
    "From: ana@example.com\nSubject: Old\nMessage-ID: <old@example.com>\nList-Id: <news.example.com>\n\nold\n"
  );

  const events = readMaildir(at("2026-10-08T00:00:00Z"), root, "Me@Mine.test");
  expect(events).toEqual([
    {
      at: "2026-10-09T08:00:00.000Z",
      bulk: false,
      chat: "mail:abc@example.com",
      chatName: "Devis",
      files: [],
      fromMe: false,
      id: "mail:abc@example.com",
      sender: "ana@example.com",
      source: "mail",
      text: "Devis\nBonjour, voici le devis.",
    },
    {
      at: "2026-10-09T08:01:00.000Z",
      bulk: false,
      chat: "mail:abc@example.com",
      chatName: "Devis",
      files: [
        {
          mime: "application/pdf",
          name: "plan.pdf",
          path: files,
          ref: "mail:reply@mine.test#2",
        },
      ],
      fromMe: true,
      id: "mail:reply@mine.test",
      sender: "me@mine.test",
      source: "mail",
      text: "Re: Devis\nOK pour lundi.",
    },
  ]);
  // A file inside a Maildir message is read back by its part number, as from an .emlx.
  expect(isMessageFile(files, root)).toBe(true);
  expect(isMessageFile(join(tmpdir(), "new", "photo.jpg"), root)).toBe(false);
  expect(messagePart(files, "mail:reply@mine.test#2")?.toString()).toBe(
    "%PDF-"
  );
  expect(readMaildir(at("2026-09-30T00:00:00Z"), root, "").at(0)?.bulk).toBe(
    true
  );
  expect(newestMaildir(root)).toEqual({
    at: "2026-10-09T09:00:00.000Z",
    words: [expect.stringMatching(NEWEST)],
  });
});

test("his addresses come from all his sent mail, an alias sent long before the window included, never a sender-less one", () => {
  const root = mkdtempSync(join(tmpdir(), "maildir-"));
  put(
    root,
    "Sent",
    "1.M1P1.host,U=1:2,S",
    "2025-01-01T08:00:00Z",
    "From: Me <alias@mine.test>\nSubject: Old\nMessage-ID: <old@mine.test>\n\nhi\n"
  );
  put(
    root,
    "Sent",
    "2.M2P1.host,U=2:2,S",
    "2025-01-02T08:00:00Z",
    "Subject: No sender\nMessage-ID: <none@mine.test>\n\nhi\n"
  );
  put(
    root,
    "INBOX",
    "3.M3P1.host,U=1:2,S",
    "2026-10-09T08:00:00Z",
    "From: alias@mine.test\nSubject: Note\nMessage-ID: <new@mine.test>\n\nto self\n"
  );
  put(
    root,
    "INBOX",
    "4.M4P1.host,U=2:2,S",
    "2026-10-09T09:00:00Z",
    "Subject: Anonymous\nMessage-ID: <anon@example.com>\n\nwho\n"
  );
  expect(
    readMaildir(at("2026-10-01T00:00:00Z"), root, "me@mine.test").map((e) => [
      e.id,
      e.fromMe,
    ])
  ).toEqual([
    ["mail:new@mine.test", true],
    ["mail:anon@example.com", false],
  ]);
});
