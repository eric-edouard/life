import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { HOUR } from "../core/clock";
import { handleKey } from "./contacts";
import {
  fromAppleNs,
  incomingImessage,
  readImessage,
  textFromAttributedBody,
  toAppleNs,
} from "./imessage";
import { imessageFixture } from "./store-fixtures";

test("Apple nanosecond dates round-trip", () => {
  const d = new Date("2026-10-10T12:00:00.000Z");
  expect(fromAppleNs(toAppleNs(d)).toISOString()).toBe(d.toISOString());
});

test("text is recovered from an archived attributed string", () => {
  const head = Buffer.from(
    "streamtyped\u0081è\u0003\u0084\u0001@\u0084\u0084\u0084\u0012NSAttributedString\u0000\u0084\u0084\u0008NSObject\u0000\u0085\u0092\u0084\u0084\u0084\u0008NSString",
    "latin1"
  );
  const body = Buffer.from("Ça marche, à demain", "utf8");
  const blob = Buffer.concat([
    head,
    Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b, body.length]),
    body,
    Buffer.from([0x86]),
  ]);
  expect(textFromAttributedBody(blob)).toBe("Ça marche, à demain");
});

test("his Contacts name a 1:1 chat Messages knows only by its number (an empty name is none)", () => {
  const db = imessageFixture("salut");
  const since = new Date(Date.now() - HOUR);
  // Contacts write the number their own way: the key is its last digits.
  const names = new Map([[handleKey("06 11 11 11 11"), "Claire Dupont"]]);
  expect(readImessage(since, db, names)[0]?.chatName).toBe("Claire Dupont");
  expect(readImessage(since, db, new Map())[0]?.chatName).toBeUndefined();
  // A group (its identifier `chat…`) is never named after a contact, whatever its digits.
  const group = new Database(db);
  group.run("update chat set chat_identifier = 'chat611111111'");
  group.close();
  expect(readImessage(since, db, names)[0]?.chatName).toBeUndefined();
});

test("incoming tells of someone else's messages by row, after a first call that only takes the cursor", () => {
  const path = imessageFixture();
  expect(incomingImessage(undefined, path)).toEqual({ chats: [], last: 1 });
  const db = new Database(path);
  // Stored late, with an old date: still heard, since rows are counted, not dates.
  db.run("insert into message values (2, 'g2', 0, 0, 'late', null, 1, 0)");
  db.run("insert into message values (3, 'g3', 0, 1, 'mine', null, 1, 0)");
  db.run("insert into chat_message_join values (1, 2), (1, 3)");
  db.close();
  expect(incomingImessage(1, path)).toEqual({
    chats: ["+33611111111"],
    last: 3,
  });
  expect(incomingImessage(3, path)).toEqual({ chats: [], last: 3 });
});
