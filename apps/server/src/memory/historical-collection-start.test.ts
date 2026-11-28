import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDb, readHeldArchived } from "../sources/archived";
import { readHeldImessage, toAppleNs } from "../sources/imessage";
import { readHeldMail } from "../sources/mail";
import { SOURCES } from "./sources";

test("every nonvoice source says what it holds, without reading events", () => {
  for (const source of SOURCES) {
    expect(typeof source.held).toBe(
      source.kind === "voice" ? "undefined" : "function"
    );
  }
});

test("what a source holds uses metadata only, ignores insertion order and leaves empty sources empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-history-start-"));
  const early = "2008-03-01T10:00:00.000Z";
  const late = "2019-05-20T09:00:00.000Z";
  const path = join(dir, "messages.sqlite");
  const messages = new Database(path);
  messages.run("create table message (date integer, item_type integer)");
  expect(readHeldImessage(path)).toEqual({
    count: 0,
    earliest: null,
    noun: "messages",
  });
  messages
    .query("insert into message values (?, ?)")
    .run(toAppleNs(new Date(late)), 0);
  messages
    .query("insert into message values (?, ?)")
    .run(toAppleNs(new Date(early)), 0);
  messages
    .query("insert into message values (?, ?)")
    .run(toAppleNs(new Date("2001-01-01T00:00:00Z")), 1);
  expect(readHeldImessage(path)).toMatchObject({ count: 2, earliest: early });
  messages.close();

  mkdirSync(join(dir, "MailData"));
  const mail = new Database(join(dir, "MailData", "Envelope Index"));
  mail.run("create table messages (date_received real)");
  expect(readHeldMail(dir)).toMatchObject({ count: 0, earliest: null });
  mail
    .query("insert into messages values (?), (?)")
    .run(Date.parse(late) / 1000, Date.parse(early) / 1000);
  expect(readHeldMail(dir)).toMatchObject({ count: 2, earliest: early });
  mail.close();

  for (const [name, table] of [
    ["whatsapp", "messages"],
    ["notes", "versions"],
    ["screen", "events"],
  ] as const) {
    const archive = new Database(archiveDb(name, dir));
    archive.run(`create table ${table} (at text)`);
    expect(readHeldArchived(name, table, dir)).toMatchObject({
      count: 0,
      earliest: null,
    });
    archive.query(`insert into ${table} values (?), (?)`).run(late, early);
    expect(readHeldArchived(name, table, dir)).toMatchObject({
      count: 2,
      earliest: early,
    });
    archive.close();
  }
});
