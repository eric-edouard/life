import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { showFiles } from "../memory/files";
import { chatLines } from "../memory/raw";
import { applyRules, daysBefore, messageUnits } from "../memory/units";
import { dayStart, localDate } from "../memory/zones";
import { noteData, notesFixture, run } from "./fixtures";
import { copyNotes, noteBody, readNotes } from "./notes";

const versions = (dir: string) =>
  new Database(join(dir, "notes.sqlite"))
    .query<{ deleted: number; note: string; text: string }, []>(
      "select note, text, deleted from versions order by rowid"
    )
    .all();

test("a body is read from gzip and old zlib, checklist lines marked by UTF-16 runs, attachments by id", () => {
  const text = "Shop 🛒\nMilk\nEggs\n￼\nend";
  const runs = [
    run(8),
    run(5, { done: 1 }),
    run(5, { done: 0 }),
    run(1, { attachment: "A1" }),
    run(5),
  ];
  const body = {
    attachments: ["A1"],
    text: "Shop 🛒\n[x] Milk\n[ ] Eggs\n\nend",
  };
  expect(noteBody(noteData(text, runs))).toEqual(body);
  expect(noteBody(noteData(text, runs, deflateSync))).toEqual(body);
});

test("a new note, an edit, a tick and a save that changes nothing each make the versions they should", () => {
  const { dir, now, save, source } = notesFixture();
  save(1, noteData("Plan\nCall Ana", [run(5), run(8, { done: 0 })]));
  expect(copyNotes(source, dir, now)).toBe(1);
  expect(copyNotes(source, dir, now + 5000)).toBe(0);
  save(1, noteData("Plan\nCall Ana", [run(5), run(8, { done: 1 })]), {
    agoS: 300,
  });
  expect(copyNotes(source, dir, now + 10_000)).toBe(1);
  // A pin or a move changes the edit time, not the text.
  save(1, noteData("Plan\nCall Ana", [run(5), run(8, { done: 1 })]), {
    agoS: 200,
  });
  expect(copyNotes(source, dir, now + 15_000)).toBe(0);
  save(1, noteData("Plan\nCall Ana\nBook flight"), { agoS: 180 });
  expect(copyNotes(source, dir, now + 20_000)).toBe(1);
  expect(versions(dir).map((v) => v.text)).toEqual([
    "Plan\n[ ] Call Ana",
    "Plan\n[x] Call Ana",
    "Plan\nCall Ana\nBook flight",
  ]);
});

test("a note being typed is archived once it has been quiet for 2 minutes", () => {
  const { dir, now, save, source } = notesFixture();
  save(1, noteData("Draft"), { agoS: 30 });
  expect(copyNotes(source, dir, now)).toBe(0);
  expect(copyNotes(source, dir, now + 89_000)).toBe(0);
  expect(copyNotes(source, dir, now + 91_000)).toBe(1);
});

test("locked and not-downloaded notes leave nothing in the archive and are never taken for deleted", () => {
  const { db, dir, now, save, source } = notesFixture();
  save(1, noteData("Bank codes"), { locked: 1 });
  save(2, null);
  db.run(
    "update ZICCLOUDSYNCINGOBJECT set ZNEEDSINITIALFETCHFROMCLOUD = 1, ZMODIFICATIONDATE1 = null where Z_PK = 2"
  );
  save(3, noteData("Groceries"), { shared: true });
  expect(copyNotes(source, dir, now)).toBe(1);
  save(3, noteData("Groceries"), { locked: 1, shared: true });
  expect(copyNotes(source, dir, now + 5000)).toBe(0);
  expect(
    new Database(join(dir, "notes.sqlite"))
      .query("select note, shared, deleted from versions")
      .all()
  ).toEqual([{ deleted: 0, note: "N3", shared: 1 }]);
});

test("a note moved to Recently Deleted, restored, then purged is deleted twice and keeps its last text", () => {
  const { db, dir, now, save, source } = notesFixture();
  save(1, noteData("Old flat keys"));
  save(2, noteData("Already binned"), { binned: true });
  expect(copyNotes(source, dir, now)).toBe(3);
  // Moving a note keeps its edit time.
  db.run("update ZICCLOUDSYNCINGOBJECT set ZFOLDER = 102 where Z_PK = 1");
  expect(copyNotes(source, dir, now + 5000)).toBe(1);
  db.run("update ZICCLOUDSYNCINGOBJECT set ZFOLDER = 101 where Z_PK = 1");
  expect(copyNotes(source, dir, now + 10_000)).toBe(1);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK = 1");
  expect(copyNotes(source, dir, now + 15_000)).toBe(1);
  expect(copyNotes(source, dir, now + 20_000)).toBe(0);
  expect(versions(dir)).toEqual([
    { deleted: 0, note: "N1", text: "Old flat keys" },
    { deleted: 0, note: "N2", text: "Already binned" },
    { deleted: 1, note: "N2", text: "" },
    { deleted: 1, note: "N1", text: "" },
    { deleted: 0, note: "N1", text: "Old flat keys" },
    { deleted: 1, note: "N1", text: "" },
  ]);
  expect(
    new Database(join(dir, "notes.sqlite"))
      .query("select note, text from deleted order by deletedSeenAt")
      .all()
  ).toEqual([
    { note: "N2", text: "Already binned" },
    { note: "N1", text: "Old flat keys" },
    { note: "N1", text: "Old flat keys" },
  ]);
});

test("more than 20 notes gone at once is a sign-out, not deletions: none is marked", () => {
  const { db, dir, now, save, source } = notesFixture();
  for (let pk = 10; pk < 31; pk += 1) {
    save(pk, noteData(`Note ${pk}`));
  }
  expect(copyNotes(source, dir, now)).toBe(21);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_ENT = 12");
  expect(copyNotes(source, dir, now + 5000)).toBe(0);
  save(10, noteData("Note 10"));
  // 20 gone is a few deletions.
  expect(copyNotes(source, dir, now + 10_000)).toBe(20);
});

test("an attachment is kept as its id, type, file in Notes' Media folder and Apple's text of it", () => {
  const { db, dir, now, save, source } = notesFixture();
  db.run(`insert into ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTYPEUTI, ZMEDIA, ZOCRSUMMARY) values
    (20, 5, 'A1', 'public.jpeg', 21, 'RECEIPT 12 EUR')`);
  db.run(`insert into ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZGENERATION1, ZACCOUNT6) values
    (21, 11, 'M1', 'IMG_1.jpeg', '1_G', 103)`);
  save(1, noteData("Receipt\n￼", [run(8), run(1, { attachment: "A1" })]));
  copyNotes(source, dir, now);
  const [row] = new Database(join(dir, "notes.sqlite"))
    .query<{ files: string; text: string }, []>(
      "select text, files from versions"
    )
    .all();
  expect(row?.text).toBe("Receipt\n");
  expect(JSON.parse(row?.files ?? "")).toEqual([
    {
      id: "A1",
      name: "IMG_1.jpeg",
      path: join(source, "Accounts/ACC/Media/M1/1_G/IMG_1.jpeg"),
      text: "RECEIPT 12 EUR",
      type: "public.jpeg",
    },
  ]);
});

test("a note gone from the store that comes back unchanged is live again", () => {
  const { db, dir, now, save, source } = notesFixture();
  save(1, noteData("Keys"));
  save(2, noteData("Other"));
  copyNotes(source, dir, now);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK = 1");
  expect(copyNotes(source, dir, now + 5000)).toBe(1);
  save(1, noteData("Keys"));
  expect(copyNotes(source, dir, now + 10_000)).toBe(1);
  expect(versions(dir).map((v) => v.deleted)).toEqual([0, 0, 1, 0]);
});

test("an edit made just before the note goes to Recently Deleted is kept", () => {
  const { db, dir, now, save, source } = notesFixture();
  save(1, noteData("v1"));
  copyNotes(source, dir, now);
  save(1, noteData("v2 important"), { agoS: 30 });
  db.run("update ZICCLOUDSYNCINGOBJECT set ZFOLDER = 102 where Z_PK = 1");
  expect(copyNotes(source, dir, now + 200_000)).toBe(2);
  expect(versions(dir).map((v) => [v.text, v.deleted])).toEqual([
    ["v1", 0],
    ["v2 important", 0],
    ["", 1],
  ]);
});

test("a version reads as what it changed: the first whole, an edit and a tick as − and + lines, a deletion, a long one whole, a shared one not his, the base from before the window", () => {
  const { db, dir, now, save, source } = notesFixture();
  const old = { agoS: 3 * 86_400 };
  save(
    1,
    noteData("Trip\nPassport\nTickets", [
      run(5),
      run(9, { done: 0 }),
      run(7, { done: 0 }),
    ]),
    old
  );
  save(2, noteData("Shared list"), { ...old, shared: true });
  save(3, noteData("x".repeat(9000)), old);
  copyNotes(source, dir, now);
  save(
    1,
    noteData("Trip\nPassport\nTickets\nHotel", [
      run(5),
      run(9, { done: 1 }),
      run(8, { done: 0 }),
      run(5),
    ])
  );
  copyNotes(source, dir, now);
  db.run("update ZICCLOUDSYNCINGOBJECT set ZFOLDER = 102 where Z_PK = 1");
  copyNotes(source, dir, now + 5000);
  const shown = (since: number) =>
    readNotes(new Date(since), dir).map((e) => [
      e.chatName,
      e.text.length > 100 ? e.text.length : e.text,
      e.deleted ? "deleted" : e.sender,
    ]);
  expect(shown(0)).toEqual([
    ["Note 1", "Trip\n[ ] Passport\n[ ] Tickets", "me"],
    ["Note 2 (shared)", "Shared list", "shared note"],
    ["Note 3", 9000, "me"],
    ["Note 1", "− [ ] Passport\n+ [x] Passport\n+ Hotel", "me"],
    ["Note 1", "[deleted the note Note 1]", "deleted"],
  ]);
  expect(shown(now - 3_600_000)).toEqual(shown(0).slice(3));
});

test("two saves in a day are one unit of two lines, the same read from its start; files only where added, Apple's text of a table", () => {
  const { db, dir, now, save, source } = notesFixture();
  db.run(`insert into ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTYPEUTI, ZMEDIA, ZSUMMARY) values
    (20, 5, 'A1', 'public.jpeg', 21, null), (22, 5, 'T1', 'com.apple.notes.table', null, 'Day Cost Mon 12')`);
  db.run(`insert into ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZACCOUNT6) values
    (21, 11, 'M1', 'IMG_1.jpeg', 103)`);
  const yesterday = dayStart(
    daysBefore(localDate(new Date(now).toISOString()), 1)
  );
  const agoS = (hour: number) =>
    (now - yesterday.getTime()) / 1000 - hour * 3600;
  const body = (text: string) =>
    noteData(`${text}\n￼￼`, [
      run(text.length + 1),
      run(1, { attachment: "A1" }),
      run(1, { attachment: "T1" }),
    ]);
  save(1, body("Budget"), { agoS: agoS(10) });
  copyNotes(source, dir, now);
  save(1, body("Budget\nRent paid"), { agoS: agoS(11) });
  copyNotes(source, dir, now);
  const events = readNotes(yesterday, dir);
  expect(events.map((e) => e.files)).toEqual([
    [{ mime: "image/jpeg", name: "IMG_1.jpeg", ref: "notes:A1" }],
    [],
  ]);
  const units = (since: Date) =>
    messageUnits(showFiles(readNotes(since, dir), new Map()), () => null);
  const built = units(yesterday);
  expect(built.map((b) => b.messages.map((m) => m.text))).toEqual([
    [
      "Budget\n[attachment: Day Cost Mon 12]\n[photo IMG_1.jpeg, not on this Mac]",
      "+ Rent paid",
    ],
  ]);
  const unit = built.map((b) => b.unit);
  expect(units(new Date(unit[0]?.start ?? "")).map((b) => b.unit)).toEqual(
    unit
  );
});

test("deletions on two days are two units, and a restore is dated when seen and read against the last live text", () => {
  const { db, dir, now, save, source } = notesFixture();
  const day = 86_400_000;
  for (const pk of [1, 2, 3]) {
    save(pk, noteData(`Note text ${pk}`), { agoS: 5 * 86_400 });
  }
  copyNotes(source, dir, now - 3 * day);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK = 1");
  copyNotes(source, dir, now - 2 * day);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK = 2");
  copyNotes(source, dir, now - day);
  save(1, noteData("Note text 1\nback"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now);
  const built = applyRules(
    messageUnits(
      showFiles(readNotes(new Date(now - 2.5 * day), dir), new Map()),
      () => null
    )
  );
  expect(built.map((b) => [b.unit.drop, b.messages[0]?.text])).toEqual([
    [undefined, "[deleted the note Note 1]"],
    [undefined, "[deleted the note Note 2]"],
    [undefined, "[restored the note Note 1]\n+ back"],
  ]);
  expect(built.at(-1)?.unit.start).toBe(new Date(now).toISOString());
});

test("two notes restored unchanged on two days are two units", () => {
  const { db, dir, now, save, source } = notesFixture();
  const day = 86_400_000;
  for (const pk of [1, 2, 3]) {
    save(pk, noteData(`Note text ${pk}`), { agoS: 5 * 86_400 });
  }
  copyNotes(source, dir, now - 4 * day);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK in (1, 2)");
  copyNotes(source, dir, now - 3 * day);
  save(1, noteData("Note text 1"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now - 2 * day);
  save(2, noteData("Note text 2"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now - day);
  const built = applyRules(
    messageUnits(
      showFiles(readNotes(new Date(now - 2.5 * day), dir), new Map()),
      () => null
    )
  );
  expect(built.map((b) => [b.unit.drop, b.messages[0]?.text])).toEqual([
    [undefined, "[restored the note Note 1]"],
    [undefined, "[restored the note Note 2]"],
  ]);
});

test("a shared note's lines are never his: extract reads them as an unknown speaker", () => {
  const { dir, now, save, source } = notesFixture();
  save(1, noteData("Groceries for the flat"), { shared: true });
  copyNotes(source, dir, now);
  const [unit] = messageUnits(
    readNotes(new Date(now - 3_600_000), dir),
    () => null
  );
  expect(unit && chatLines(unit, () => null).map((l) => l.speaker)).toEqual([
    "unknown:shared note",
  ]);
  expect(unit?.unit.stats.fromMe).toBe(0);
});
