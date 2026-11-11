import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveDb, readEarliestArchived } from "../sources/archived";
import { readEarliestImessage, toAppleNs } from "../sources/imessage";
import { readEarliestMail } from "../sources/mail";
import { SOURCES } from "./sources";

test("every nonvoice source supplies its earliest timestamp without reading events", () => {
  for (const source of SOURCES) {
    expect(typeof source.earliest).toBe(
      source.kind === "voice" ? "undefined" : "function"
    );
  }
});

test("history starts use metadata only, ignore insertion order and leave empty sources empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-history-start-"));
  const early = "2008-03-01T10:00:00.000Z";
  const late = "2019-05-20T09:00:00.000Z";
  const path = join(dir, "messages.sqlite");
  const messages = new Database(path);
  messages.run("create table message (date integer, item_type integer)");
  expect(readEarliestImessage(path)).toBeNull();
  messages
    .query("insert into message values (?, ?)")
    .run(toAppleNs(new Date(late)), 0);
  messages
    .query("insert into message values (?, ?)")
    .run(toAppleNs(new Date(early)), 0);
  messages
    .query("insert into message values (?, ?)")
    .run(toAppleNs(new Date("2001-01-01T00:00:00Z")), 1);
  expect(readEarliestImessage(path)).toBe(early);
  messages.close();

  mkdirSync(join(dir, "MailData"));
  const mail = new Database(join(dir, "MailData", "Envelope Index"));
  mail.run("create table messages (date_received real)");
  expect(readEarliestMail(dir)).toBeNull();
  mail
    .query("insert into messages values (?), (?)")
    .run(Date.parse(late) / 1000, Date.parse(early) / 1000);
  expect(readEarliestMail(dir)).toBe(early);
  mail.close();

  for (const [name, table] of [
    ["whatsapp", "messages"],
    ["notes", "versions"],
    ["screen", "events"],
  ] as const) {
    const archive = new Database(archiveDb(name, dir));
    archive.run(`create table ${table} (at text)`);
    expect(readEarliestArchived(name, table, dir)).toBeNull();
    archive.query(`insert into ${table} values (?), (?)`).run(late, early);
    expect(readEarliestArchived(name, table, dir)).toBe(early);
    archive.close();
  }
});
