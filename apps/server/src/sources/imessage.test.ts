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

test("incoming: the messages Messages stored from a row on, with readImessage's ids", () => {
  const db = imessageFixture("salut");
  const fresh = incomingImessage(1, db);
  expect(fresh.end).toBe(2);
  expect(fresh.rows.map((r) => [r.row, r.id])).toEqual(
    readImessage(new Date(0), db, new Map()).map((e) => [1, e.id])
  );
  expect(incomingImessage(fresh.end, db).rows).toEqual([]);
});
