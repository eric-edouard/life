import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { ARCHIVED } from "../memory/sources";
import { archiveDb } from "../sources/archived";
import { copyNotes, readNotes } from "../sources/notes";
import {
  noteData,
  notesFixture,
  whatsappFixture,
} from "../sources/store-fixtures";
import { copyWhatsapp, readWhatsapp } from "../sources/whatsapp";
import { heldThrough, mintCompanionToken, push, receive } from "./companion";
import { createCompanion } from "./http/companion";

const hubDir = mkdtempSync(join(tmpdir(), "hub-archive-"));
// The route stores into the archive it is given; the test's hub is this folder.
const hub = Bun.serve({
  fetch: (req) => createCompanion(hubDir).fetch(req),
  port: 0,
});
afterAll(() => hub.stop());
const token = mintCompanionToken();
const stores = ARCHIVED.filter((s) => ["notes", "whatsapp"].includes(s.name));
const rows = (dir: string, name: string, table: string) =>
  new Database(archiveDb(name, dir), { readonly: true })
    .query(`select rowid, * from ${table} order by rowid`)
    .all();

test("a message in, then deleted for everyone: the hub's copy reads it deleted, by the same reader", async () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  add(1, "S1", 0, "pay the carpenter");
  copyWhatsapp(source, dir, now);
  expect(await push(hub.url.href, token, dir, stores)).toBe(1);

  wa.run("update ZWAMESSAGE set ZTEXT = null where ZSTANZAID = 'S1'");
  add(2, "S2", 14, null);
  // Two new versions (the wiped text, the placeholder); the first row is not sent again.
  expect(copyWhatsapp(source, dir, now + 5000)).toBe(2);
  expect(await push(hub.url.href, token, dir, stores)).toBe(2);

  expect(rows(hubDir, "whatsapp", "messages")).toEqual(
    rows(dir, "whatsapp", "messages")
  );
  // The hub has no WhatsApp app: its reader sees the archive alone.
  const events = readWhatsapp(
    new Date(now - HOUR),
    hubDir,
    join(hubDir, "no-app")
  );
  expect(events).toMatchObject([{ deleted: true, text: "pay the carpenter" }]);
});

test("a resend is ignored by its rowid, also in a table with no key of its own", async () => {
  const { dir, now, save, source } = notesFixture();
  save(1, noteData("Groceries\nmilk"));
  copyNotes(source, dir, now);
  await push(hub.url.href, token, dir, stores);
  const sent = rows(dir, "notes", "versions") as { rowid: number }[];
  expect(
    receive({ rows: sent, store: "notes", table: "versions" }, hubDir)
  ).toBe(0);
  expect(rows(hubDir, "notes", "versions")).toEqual(sent);
  expect(heldThrough(hubDir)["notes.versions"]).toBe(sent.length);
  expect(readNotes(new Date(now - HOUR), hubDir).map((e) => e.text)).toEqual(
    readNotes(new Date(now - HOUR), dir).map((e) => e.text)
  );
});

test("the hub takes nothing without the token, and nothing its own schema lacks", async () => {
  const post = (auth: string, body: unknown) =>
    fetch(new URL("/companion/push", hub.url), {
      body: JSON.stringify(body),
      headers: { authorization: auth },
      method: "POST",
    });
  expect((await post("Bearer wrong", {})).status).toBe(401);
  expect((await fetch(new URL("/companion/cursors", hub.url))).status).toBe(
    401
  );
  const bad = await post(`Bearer ${token}`, {
    rows: [{ evil: "x", rowid: 9 }],
    store: "notes",
    table: "versions",
  });
  expect(bad.status).toBe(400);
  expect(await bad.text()).toContain("no column notes.versions.evil");
  expect(
    (
      await post(`Bearer ${token}`, {
        rows: [],
        store: "notes",
        table: "sqlite_master",
      })
    ).status
  ).toBe(400);
});
