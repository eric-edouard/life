import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { DAY, HOUR } from "../core/clock";
import { incomingArchived } from "./archived";
import { BRIDGES } from "./matrix";
import { proto, whatsappFixture } from "./store-fixtures";
import {
  copyWhatsapp,
  phoneCallOf,
  readWhatsapp,
  WHATSAPP,
  whatsappEventOf,
  whatsappGhostOf,
  whatsappHandleOf,
  whatsappIdOf,
  whatsappRoomOf,
} from "./whatsapp";

test("the archive reads deleted and edited messages by their last text, with senders resolved to phones", () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  add(1, "S1", 0, "pay the carpenter");
  add(2, "S2", 0, "meet at 9");
  add(3, "S3", 6, '{"author":"777@lid"}');
  copyWhatsapp(source, dir, now);
  // S1 is deleted for everyone: its text is wiped and a placeholder added. S2 is edited.
  wa.run("update ZWAMESSAGE set ZTEXT = null where ZSTANZAID = 'S1'");
  wa.run("update ZWAMESSAGE set ZTEXT = 'meet at 10' where ZSTANZAID = 'S2'");
  add(4, "S4", 14, null);
  copyWhatsapp(source, dir, now + 5000);

  const events = readWhatsapp(new Date(now - HOUR), dir, source);
  expect(events.map((e) => e.text).sort()).toEqual([
    "meet at 10",
    "pay the carpenter",
  ]);
  expect(events[0]).toMatchObject({
    chat: "120@g.us",
    chatName: "Team",
    fromMe: false,
    sender: "+66600000001",
    source: "whatsapp",
  });
});

test("a call is a message of its chat: its details copied as they change, read as its length and kind", () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  const details = (seconds: number, video: number) =>
    proto([87, proto([1, proto([1, video], [2, 0], [3, seconds])])]);
  add(1, "C1", 59, null);
  wa.run("insert into ZWAMEDIAITEM (Z_PK, ZMETADATA) values (1, ?)", [
    details(0, 1),
  ]);
  wa.run("update ZWAMESSAGE set ZMEDIAITEM = 1 where Z_PK = 1");
  copyWhatsapp(source, dir, now);
  // The call ends: WhatsApp writes its length.
  wa.run("update ZWAMEDIAITEM set ZMETADATA = ? where Z_PK = 1", [
    details(412, 1),
  ]);
  copyWhatsapp(source, dir, now + 5000);

  const [call] = readWhatsapp(new Date(now - HOUR), dir, source);
  expect(call?.phoneCall).toEqual({ seconds: 412, video: true });
  expect(phoneCallOf(details(0, 0))).toEqual({ seconds: 0, video: false });
  // An archive the new code has not opened yet (Life just updated) has no `phone_calls`: its calls read with no details.
  const old = new Database(join(dir, "whatsapp.sqlite"));
  old.run("drop table phone_calls");
  old.close();
  expect(
    readWhatsapp(new Date(now - HOUR), dir, source)[0]?.phoneCall
  ).toBeUndefined();
});

test("incoming: an edit or a delete is a later row of the same message, never a new one", () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  add(1, "S1", 0, "meet at 9");
  copyWhatsapp(source, dir, now);
  wa.run("update ZWAMESSAGE set ZTEXT = 'meet at 10' where ZSTANZAID = 'S1'");
  add(2, "S2", 0, "on my way");
  copyWhatsapp(source, dir, now + 5000);
  const ids = readWhatsapp(new Date(now - HOUR), dir, source).map((e) => e.id);
  const fresh = incomingArchived("whatsapp", "id", 1, dir);
  expect(fresh.rows.map((r) => r.id).sort()).toEqual(ids.sort());
  expect(incomingArchived("whatsapp", "id", fresh.end, dir).rows).toEqual([]);
});

test("an archived source range excludes its end instant", () => {
  const { add, dir, now, source } = whatsappFixture();
  add(1, "bounded", 0, "a made-up message");
  copyWhatsapp(source, dir, now);
  const [event] = readWhatsapp(new Date(0), dir, source);
  expect(event).toBeDefined();
  expect(
    readWhatsapp(new Date(0), dir, source, new Date(event?.at ?? ""))
  ).toEqual([]);
});

test("a full older-store copy is append-only and repeatable, including missing media and orphan calls", () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  add(1, "recent", 0, "already archived");
  expect(copyWhatsapp(source, dir, now)).toBe(1);
  const archive = new Database(join(dir, "whatsapp.sqlite"));
  try {
    const original = archive.query("select rowid, * from messages").all();
    const details = proto([87, proto([1, proto([3, 120])])]);
    // An existing call table must not restrict the explicit full copy to a week.
    archive.run(
      "insert into phone_calls values ('120@g.us', 'existing', ?, ?)",
      [details, "2026-01-01T00:00:00Z"]
    );
    const originalCalls = archive
      .query("select rowid, * from phone_calls")
      .all();
    add(
      2,
      "old-photo",
      1,
      "old caption",
      (4000 * DAY) / 1000,
      "Media/missing.jpg"
    );
    add(3, "old-call", 59, null, (4000 * DAY) / 1000);
    add(4, "orphan-call", 59, null, (4000 * DAY) / 1000);
    wa.run("insert into ZWAMEDIAITEM (Z_PK, ZMETADATA) values (3, ?), (4, ?)", [
      details,
      details,
    ]);
    wa.run("update ZWAMESSAGE set ZMEDIAITEM = Z_PK where Z_PK in (3, 4)");
    wa.run("update ZWAMESSAGE set ZCHATSESSION = null where Z_PK = 4");
    rmSync(join(source, "Message"), { recursive: true });
    expect(copyWhatsapp(source, dir, now + 5000)).toBe(0);
    expect(copyWhatsapp(source, dir, now + 10_000, true)).toBe(3);
    expect(
      archive.query("select rowid, * from messages where id = 'recent'").all()
    ).toEqual(original);
    expect(
      archive
        .query("select rowid, * from phone_calls where id = 'existing'")
        .all()
    ).toEqual(originalCalls);
    const messages = archive
      .query("select rowid, * from messages order by rowid")
      .all();
    const calls = archive
      .query("select rowid, * from phone_calls order by rowid")
      .all();
    expect(calls).toHaveLength(3);
    expect(copyWhatsapp(source, dir, now + 15_000, true)).toBe(0);
    expect(
      archive.query("select rowid, * from messages order by rowid").all()
    ).toEqual(messages);
    expect(
      archive.query("select rowid, * from phone_calls order by rowid").all()
    ).toEqual(calls);
    const photo = readWhatsapp(new Date(0), dir, dir).find((e) =>
      e.id.endsWith("/old-photo")
    );
    expect(photo).toMatchObject({
      sender: "+66600000001",
      text: "old caption",
    });
    expect(photo?.files?.[0]).toMatchObject({
      mime: "image/jpeg",
      ref: "whatsapp:120@g.us/old-photo",
    });
    expect(photo?.files?.[0]?.path).toBeUndefined();
    expect(
      archive.query("select media from messages where id = 'old-photo'").get()
    ).toEqual({ media: "Media/missing.jpg" });
    expect(existsSync(join(dir, "media/Media/missing.jpg"))).toBe(false);
  } finally {
    archive.close();
    wa.close();
  }
});

test("a backup without ContactsV2 uses the Mac's contacts for sender LIDs", () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  // WHATSAPP is inside the test's isolated home, never the owner's app folder.
  mkdirSync(WHATSAPP, { recursive: true });
  const contacts = join(WHATSAPP, "ContactsV2.sqlite");
  copyFileSync(join(source, "ContactsV2.sqlite"), contacts);
  rmSync(join(source, "ContactsV2.sqlite"));
  try {
    add(1, "backup", 0, "a made-up message");
    expect(copyWhatsapp(source, dir, now, true)).toBe(1);
    expect(readWhatsapp(new Date(0), dir, dir)[0]?.sender).toBe("+66600000001");
  } finally {
    rmSync(contacts);
    wa.close();
  }
});

test("an older snapshot fills missing identities without replacing archived messages or calls", () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  const details = (seconds: number) =>
    proto([87, proto([1, proto([3, seconds])])]);
  add(1, "edited", 0, "latest text");
  add(2, "empty", 0, "");
  add(3, "call", 59, null);
  wa.run("insert into ZWAMEDIAITEM (Z_PK, ZMETADATA) values (3, ?)", [
    details(412),
  ]);
  wa.run("update ZWAMESSAGE set ZMEDIAITEM = 3 where Z_PK = 3");
  copyWhatsapp(source, dir, now);
  const archive = new Database(join(dir, "whatsapp.sqlite"));
  try {
    const original = archive
      .query("select rowid, * from messages order by rowid")
      .all();
    const originalCalls = archive
      .query("select rowid, * from phone_calls order by rowid")
      .all();
    wa.run("update ZWAMESSAGE set ZTEXT = 'old text' where Z_PK in (1, 2)");
    wa.run("update ZWAMEDIAITEM set ZMETADATA = ? where Z_PK = 3", [
      details(0),
    ]);
    add(4, "missing", 0, "only in snapshot");
    expect(copyWhatsapp(source, dir, now + 5000, true)).toBe(1);
    expect(
      archive
        .query(
          "select rowid, * from messages where id <> 'missing' order by rowid"
        )
        .all()
    ).toEqual(original);
    expect(
      archive.query("select rowid, * from phone_calls order by rowid").all()
    ).toEqual(originalCalls);
    const events = readWhatsapp(new Date(0), dir, source);
    expect(events.find((e) => e.id.endsWith("/edited"))?.text).toBe(
      "latest text"
    );
    expect(events.find((e) => e.id.endsWith("/empty"))?.text).toBe("");
    expect(events.find((e) => e.id.endsWith("/call"))?.phoneCall?.seconds).toBe(
      412
    );
    expect(events.find((e) => e.id.endsWith("/missing"))?.text).toBe(
      "only in snapshot"
    );
    wa.run("update ZWAMESSAGE set ZTEXT = 'live edit' where Z_PK = 4");
    copyWhatsapp(source, dir, now + 10_000);
    expect(
      readWhatsapp(new Date(0), dir, source).find((e) =>
        e.id.endsWith("/missing")
      )?.text
    ).toBe("live edit");
  } finally {
    archive.close();
    wa.close();
  }
});

test("an older deletion placeholder cannot delete an archived live message with a different id", () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  add(1, "live", 0, "current message");
  copyWhatsapp(source, dir, now);
  const before = readWhatsapp(new Date(0), dir, source);
  add(2, "old-deletion", 14, null);
  try {
    copyWhatsapp(source, dir, now + 5000, true);
    expect(readWhatsapp(new Date(0), dir, source)).toEqual(before);
    expect(copyWhatsapp(source, dir, now + 10_000)).toBe(1);
    expect(readWhatsapp(new Date(0), dir, source)[0]?.deleted).toBe(true);
  } finally {
    wa.close();
  }
});

test("a full copy keeps a deletion its own store holds beside the message", () => {
  const { add, dir, now, source, wa } = whatsappFixture();
  add(1, "message", 0, "a made-up message");
  add(2, "deletion", 14, null);
  try {
    copyWhatsapp(source, dir, now, true);
    expect(readWhatsapp(new Date(0), dir, source)[0]?.deleted).toBe(true);
  } finally {
    wa.close();
  }
});

test("a chat's room in the WhatsApp bridge: by its id, a phone's through the bridge's own map, none for a chat the bridge never saw", () => {
  const bridges = join(BRIDGES, "..", `wa-${crypto.randomUUID()}`);
  expect(whatsappRoomOf("155@s.whatsapp.net", bridges)).toBeUndefined();
  mkdirSync(join(bridges, "whatsapp"), { recursive: true });
  const db = new Database(join(bridges, "whatsapp", "whatsapp.db"));
  db.run("create table portal (id text not null, mxid text)");
  db.run(
    "create table whatsmeow_lid_map (lid text primary key, pn text unique not null)"
  );
  db.run(
    "insert into portal values ('900@lid', '!kit:life.local'), ('120@g.us', '!group:life.local'), ('901@lid', null)"
  );
  db.run("insert into whatsmeow_lid_map values ('900', '155'), ('901', '156')");
  db.close();
  expect(whatsappRoomOf("155@s.whatsapp.net", bridges)).toBe("!kit:life.local");
  expect(whatsappRoomOf("900@lid", bridges)).toBe("!kit:life.local");
  expect(whatsappRoomOf("120@g.us", bridges)).toBe("!group:life.local");
  expect(whatsappRoomOf("156@s.whatsapp.net", bridges)).toBeUndefined();
  expect(whatsappRoomOf("157@s.whatsapp.net", bridges)).toBeUndefined();
});

test("a person's chat id is the handle the bridge opens a chat by; a group's or a name is not", () => {
  expect(whatsappHandleOf("155@s.whatsapp.net")).toBe("155@s.whatsapp.net");
  expect(whatsappHandleOf("900@lid")).toBe("900@lid");
  expect(whatsappHandleOf("120@g.us")).toBeUndefined();
  expect(whatsappHandleOf("Test Kit")).toBeUndefined();
});

test("a message id of Life's is the bridge's one message of that chat ending in its stanza: a duplicate, a pk id, another chat's or an unknown stanza is none", () => {
  const bridges = join(BRIDGES, "..", `wa-${crypto.randomUUID()}`);
  mkdirSync(join(bridges, "whatsapp"), { recursive: true });
  const db = new Database(join(bridges, "whatsapp", "whatsapp.db"));
  db.run("create table portal (id text not null, mxid text)");
  db.run(
    "create table whatsmeow_lid_map (lid text primary key, pn text unique not null)"
  );
  db.run(
    "create table message (id text not null, room_id text not null, mxid text not null)"
  );
  db.run(
    "insert into portal values ('900@lid', '!kit:life.local'), ('901@lid', '!ana:life.local')"
  );
  db.run("insert into whatsmeow_lid_map values ('900', '155')");
  db.run(`insert into message values
    ('900@lid:900@lid:AAA1', '900@lid', '$one'),
    ('900@lid:1234@s.whatsapp.net:BBB2', '900@lid', '$two'),
    ('900@lid:900@lid:DUP3', '900@lid', '$dup1'),
    ('900@lid:1234@s.whatsapp.net:DUP3', '900@lid', '$dup2'),
    ('901@lid:901@lid:AAA1', '901@lid', '$other')`);
  db.close();
  const kit = "155@s.whatsapp.net";
  expect(whatsappEventOf(kit, `whatsapp:${kit}/AAA1`, bridges)).toBe("$one");
  expect(whatsappEventOf(kit, `whatsapp:${kit}/BBB2`, bridges)).toBe("$two");
  // A suffix is a whole stanza: `A1` is not `AAA1`.
  expect(whatsappEventOf(kit, `whatsapp:${kit}/A1`, bridges)).toBeUndefined();
  expect(whatsappEventOf(kit, `whatsapp:${kit}/DUP3`, bridges)).toBeUndefined();
  expect(whatsappEventOf(kit, `whatsapp:${kit}/pk:7`, bridges)).toBeUndefined();
  expect(whatsappEventOf(kit, `whatsapp:${kit}/ZZZ`, bridges)).toBeUndefined();
  expect(
    whatsappEventOf(kit, "whatsapp:156@s.whatsapp.net/AAA1", bridges)
  ).toBeUndefined();
  expect(whatsappEventOf("901@lid", "whatsapp:901@lid/AAA1", bridges)).toBe(
    "$other"
  );
  expect(
    whatsappEventOf(kit, `whatsapp:${kit}/AAA1`, join(bridges, "nowhere"))
  ).toBeUndefined();
  // What the bridge sent comes back as the id the Mac app will give it.
  expect(whatsappIdOf(kit, "$two", bridges)).toBe(`whatsapp:${kit}/BBB2`);
  expect(whatsappIdOf(kit, "$unknown", bridges)).toBe("$unknown");
});

test("a sender is the bridge's ghost by its WhatsApp user id: a phone's digits, a lid's `lid-<n>`", () => {
  mkdirSync(join(BRIDGES, "whatsapp"), { recursive: true });
  writeFileSync(
    join(BRIDGES, "whatsapp", "config.yaml"),
    "appservice:\n  username_template: whatsapp_{{.}}\n"
  );
  try {
    expect(whatsappGhostOf("+66600000001")).toBe(
      "@whatsapp_66600000001:life.local"
    );
    expect(whatsappGhostOf("777@lid")).toBe("@whatsapp_lid-777:life.local");
    expect(whatsappGhostOf("120@g.us")).toBeUndefined();
    expect(whatsappGhostOf("Test Ana")).toBeUndefined();
  } finally {
    rmSync(join(BRIDGES, "whatsapp"), { force: true, recursive: true });
  }
});
