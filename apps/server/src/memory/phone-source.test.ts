import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SourceEvent } from "../records/source";
import { toAppleS } from "../sources/imessage";
import { copyPhone, isPhoneGroup, readPhone } from "../sources/phone";
import { chatDays } from "./closeness";
import { chatPerson, textOf } from "./units";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "life-phone-"));
  const source = join(dir, "CallHistory.storedata");
  const db = new Database(source);
  db.run(`create table ZCALLRECORD (Z_PK integer primary key, ZUNIQUE_ID text, ZDATE real,
    ZADDRESS text, ZORIGINATED integer, ZANSWERED integer, ZDURATION real,
    ZCALLTYPE integer, ZSERVICE_PROVIDER text, ZPARTICIPANTGROUPUUID text);
    create table ZHANDLE (Z_PK integer, ZVALUE text);
    create table Z_2REMOTEPARTICIPANTHANDLES (Z_2REMOTEPARTICIPANTCALLS integer, Z_4REMOTEPARTICIPANTHANDLES integer)`);
  const at = "2026-10-01T23:30:00.250Z";
  const add = (
    id: number,
    duration: number | null = 12.6,
    answered = 0,
    type = 1,
    provider: string | null = "com.apple.Telephony",
    fromMe = 1
  ) =>
    db.run("insert into ZCALLRECORD values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [
      id,
      `call-${id}`,
      toAppleS(Date.parse(at)),
      "+15550000001",
      fromMe,
      answered,
      duration,
      type,
      provider,
      "uuid-even-for-one",
    ]);
  return { add, at, db, dir, source };
}
const since = new Date("2026-01-01T00:00:00Z");

test("phone archives versions once, rescans old calls, and survives Apple pruning", () => {
  const { add, at, db, dir, source } = fixture();
  try {
    add(1, null);
    expect(copyPhone(source, dir)).toBe(1);
    expect(copyPhone(source, dir)).toBe(0);
    const [before] = readPhone(since, dir, new Map());
    expect(before?.phoneCall?.seconds).toBeUndefined();
    db.run("update ZCALLRECORD set ZDURATION = 12.6");
    expect(copyPhone(source, dir)).toBe(1);
    add(2);
    expect(copyPhone(source, dir)).toBe(1);
    db.run("delete from ZCALLRECORD");
    expect(copyPhone(source, dir)).toBe(0);
    const calls = readPhone(since, dir, new Map());
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({
      at,
      chat: "+15550000001",
      fromMe: true,
      phoneCall: { seconds: 13, video: false },
      sender: "me",
      text: "",
    });
    expect(calls[0]?.id).toBe(before?.id);
    const days = chatDays(calls, (s) =>
      s === "+15550000001" ? "person:friend" : null
    );
    // The synthetic owner is in Jakarta (UTC+7) on this date: a late UTC call belongs to the next local day.
    expect([...(days.get("person:friend")?.keys() ?? [])]).toEqual([
      "2026-10-02",
    ]);
    expect(SourceEvent.safeParse(calls[0]).success).toBe(true);
    expect(readPhone(new Date("2026-10-02T00:00:00Z"), dir, new Map())).toEqual(
      []
    );
    expect(textOf(calls[0] as SourceEvent)).toContain("13 s");
    expect(
      chatPerson(calls, (s) => (s === "+15550000001" ? "person:friend" : null))
    ).toBe("person:friend");
  } finally {
    db.close();
  }
});

test("a call returning to an earlier payload still becomes the latest version", () => {
  const { add, db, dir, source } = fixture();
  try {
    add(1, 0);
    expect(copyPhone(source, dir)).toBe(1);
    db.run("update ZCALLRECORD set ZDURATION = 60");
    expect(copyPhone(source, dir)).toBe(1);
    db.run("update ZCALLRECORD set ZDURATION = 0");
    expect(copyPhone(source, dir)).toBe(1);
    expect(copyPhone(source, dir)).toBe(0);
    expect(readPhone(since, dir, new Map())[0]?.phoneCall?.seconds).toBe(0);
    const archive = new Database(join(dir, "phone.sqlite"), { readonly: true });
    expect(archive.query("select count(*) as n from calls").get()).toEqual({
      n: 3,
    });
    archive.close();
  } finally {
    db.close();
  }
});

test("phone providers, call types, missing ends and fractional seconds keep their meanings", () => {
  const { add, db, dir, source } = fixture();
  try {
    add(1, 0, 0, 1, "com.apple.Telephony", 0);
    add(2, 0, 1, 16, "com.apple.FaceTime", 0);
    add(3, 0.2, 0, 8, "com.apple.FaceTime");
    add(4, null);
    add(5, 60, 1, 0, "net.whatsapp.WhatsApp");
    add(6, 60, 1, 1, "unknown");
    add(7, 60, 1, 1, null);
    copyPhone(source, dir);
    const calls = readPhone(since, dir, new Map());
    expect(calls.map((e) => e.phoneCall)).toEqual([
      { seconds: 0, video: false },
      { video: false },
      { seconds: 1, video: true },
      { video: false },
    ]);
    expect(calls[0]?.sender).toBe("+15550000001");
  } finally {
    db.close();
  }
});

test("joined participants define groups, Contacts only name handles, unresolved calls stay unresolved", () => {
  const { add, db, dir, source } = fixture();
  try {
    add(1);
    add(2);
    add(3);
    db.run(`insert into ZHANDLE values (1, '+15550000001'), (2, 'friend@example.test');
      insert into Z_2REMOTEPARTICIPANTHANDLES values (2, 2), (2, 1), (2, 1);
      update ZCALLRECORD set ZADDRESS = null where Z_PK = 3`);
    copyPhone(source, dir);
    const [one, group, unknown] = readPhone(
      since,
      dir,
      new Map([["550000001", "Friend"]])
    );
    expect(one?.chatName).toBe("Friend");
    expect(isPhoneGroup(one?.chat ?? "")).toBe(false);
    expect(isPhoneGroup(group?.chat ?? "")).toBe(true);
    expect(group?.chat).toBe('group:["+15550000001","friend@example.test"]');
    expect(unknown?.chat).toBe("unknown:call-3");
    expect(
      chatPerson([one as SourceEvent], (s) =>
        s === "Friend" ? "person:wrong" : null
      )
    ).toBeNull();
    expect(chatDays([group as SourceEvent], () => "person:friend").size).toBe(
      0
    );
  } finally {
    db.close();
  }
});
