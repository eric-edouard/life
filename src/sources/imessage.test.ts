import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { showFiles } from "../memory/files";
import { imessageFixture } from "./fixtures";
import {
  fromAppleNs,
  readImessage,
  textFromAttributedBody,
  toAppleNs,
} from "./imessage";

test("a photo-only message carries its attachments as files, a link preview left out", () => {
  const photo = join(mkdtempSync(join(tmpdir(), "att-")), "IMG_2910.HEIC");
  writeFileSync(photo, "bytes");
  // The text Messages keeps for a photo-only message: one U+FFFC.
  const db = imessageFixture(String.fromCharCode(0xff_fc), [
    { mime: "image/heic", name: "IMG_2910.HEIC", path: photo },
    // Never downloaded to this Mac, and Messages left its type out.
    { mime: null, name: "Audio Message.caf", path: null },
  ]);
  const read = (d: Date) => readImessage(d, db);
  const since = new Date(Date.now() - 3_600_000);
  expect(read(since)[0]?.files).toEqual([
    {
      mime: "image/heic",
      name: "IMG_2910.HEIC",
      path: photo,
      ref: "imessage:at_0",
    },
    { mime: "audio/x-caf", name: "Audio Message.caf", ref: "imessage:at_1" },
  ]);
  expect(showFiles(read(since), new Map())[0]?.text).toBe(
    "[photo IMG_2910.HEIC]\n[audio Audio Message.caf, not on this Mac]"
  );
});

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
