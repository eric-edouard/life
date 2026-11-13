import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { digest } from "../core/hash";
import type { SourceEvent, SourceFile } from "../records/source";
import type { FileEntry } from "../records/unit";
import { readImessage } from "../sources/imessage";
import { imessageFixture, whatsappFixture } from "../sources/store-fixtures";
import { copyWhatsapp, readWhatsapp } from "../sources/whatsapp";
import { showFiles, triage } from "./message-files";
import { locate } from "./quote-check";

const madeBy = {
  engine: "codex" as const,
  model: "m",
  prompt: "files.v1",
  run: "r",
};
const hashOf = (s: string) => digest("sha256", s, 16);
const id: FileEntry = {
  hash: hashOf("id-card"),
  madeBy,
  ref: "imessage:at_0",
  schemaVersion: 1,
  text: "RÉPUBLIQUE FRANÇAISE CARTE NATIONALE D'IDENTITÉ",
  what: "French national identity card of Anne-Sophie.",
};
const photo = (ref: string, path?: string): SourceFile => ({
  mime: "image/heic",
  name: "IMG_2910.HEIC",
  ref,
  ...(path ? { path } : {}),
});
const event = (...files: SourceFile[]): SourceEvent => ({
  at: "2026-10-17T04:01:00.000Z",
  chat: "+33600000000",
  files,
  fromMe: false,
  id: "imessage:g1",
  sender: "+33600000000",
  source: "imessage",
  text: "￼",
});

test("a file read once shows its description by its ref, also once it is gone; one never read and gone is a tag", () => {
  const known = new Map([[id.ref, id]]);
  const line = `[photo IMG_2910.HEIC, described by Life: ${id.what} | text: ${id.text}]`;
  expect(showFiles([event(photo(id.ref, "/here.heic"))], known)[0]?.text).toBe(
    line
  );
  expect(showFiles([event(photo(id.ref))], known)[0]?.text).toBe(line);
  // An observation may quote it: the quote check finds Life's description in the line.
  expect(locate("identity card of Anne-Sophie", [line])?.line).toBe(0);
  expect(showFiles([event(photo("imessage:at_1"))], known)[0]?.text).toBe(
    "[photo IMG_2910.HEIC, not on this Mac]"
  );
});

test("triage: a known ref is not opened, a known hash is copied under its new ref, a new content is listed once", async () => {
  const bytes: Record<string, string> = {
    "/a.heic": "id-card",
    "/b.heic": "beach",
    "/c.heic": "beach",
  };
  const opened: string[] = [];
  const { copies, fresh } = await triage(
    [
      event(
        photo(id.ref, "/old.heic"),
        photo("whatsapp:chat/forwarded", "/a.heic"),
        photo("whatsapp:chat/b", "/b.heic"),
        photo("line:c", "/c.heic"),
        photo("line:gone"),
        { mime: "video/mp4", path: "/v.mp4", ref: "line:video" }
      ),
    ],
    [id],
    (f) => {
      opened.push(f.path);
      return Promise.resolve(Buffer.from(bytes[f.path] ?? ""));
    }
  );
  expect(opened).toEqual(["/a.heic", "/b.heic", "/c.heic"]);
  expect(copies).toEqual([{ ...id, ref: "whatsapp:chat/forwarded" }]);
  expect([...fresh.values()].map((c) => [c.hash, c.refs])).toEqual([
    [hashOf("beach"), ["whatsapp:chat/b", "line:c"]],
  ]);
});

test("a photo-only message carries its attachments as files, a link preview left out", () => {
  const image = join(mkdtempSync(join(tmpdir(), "att-")), "IMG_2910.HEIC");
  writeFileSync(image, "bytes");
  // The text Messages keeps for a photo-only message: one U+FFFC.
  const db = imessageFixture(String.fromCharCode(0xff_fc), [
    { mime: "image/heic", name: "IMG_2910.HEIC", path: image },
    // Never downloaded to this Mac, and Messages left its type out.
    { mime: null, name: "Audio Message.caf", path: null },
  ]);
  const read = (d: Date) => readImessage(d, db);
  const since = new Date(Date.now() - HOUR);
  expect(read(since)[0]?.files).toEqual([
    {
      mime: "image/heic",
      name: "IMG_2910.HEIC",
      path: image,
      ref: "imessage:at_0",
    },
    { mime: "audio/x-caf", name: "Audio Message.caf", ref: "imessage:at_1" },
  ]);
  expect(showFiles(read(since), new Map())[0]?.text).toBe(
    "[photo IMG_2910.HEIC]\n[audio Audio Message.caf, not on this Mac]"
  );
});

test("a phone call has no words and no file, and is kept: its readers write its line", () => {
  const call = {
    at: "2026-11-10T09:00:00.000Z",
    chat: "+33600000001",
    fromMe: false,
    id: "phone:+33600000001/1",
    phoneCall: { seconds: 90, video: false },
    sender: "+33600000001",
    source: "phone" as const,
    text: "",
  };
  expect(
    showFiles([call, { ...call, phoneCall: undefined }], new Map())
  ).toEqual([call]);
});

test("media rows are files: the archive's copy, a document's name, a photo never downloaded", () => {
  const { add, dir, now, source } = whatsappFixture();
  add(1, "P1", 1, null, 300, "Media/120@g.us/a/photo.jpg");
  add(2, "D1", 8, "plan R19.pdf", 200, "Media/120@g.us/b/doc.pdf");
  add(3, "P2", 1, null, 100);
  // A link's media is its preview, not a file.
  add(4, "L1", 7, "https://example.com", 50, "Media/120@g.us/c/preview.jpg");
  copyWhatsapp(source, dir, now);
  const read = (d: Date) => readWhatsapp(d, dir, source);
  const since = new Date(now - HOUR);
  expect(read(since).map((e) => e.files)).toEqual([
    [
      {
        mime: "image/jpeg",
        path: join(dir, "media", "Media/120@g.us/a/photo.jpg"),
        ref: "whatsapp:120@g.us/P1",
      },
    ],
    [
      {
        mime: "application/pdf",
        name: "plan R19.pdf",
        path: join(dir, "media", "Media/120@g.us/b/doc.pdf"),
        ref: "whatsapp:120@g.us/D1",
      },
    ],
    [{ mime: "image/jpeg", ref: "whatsapp:120@g.us/P2" }],
    [],
  ]);
  expect(showFiles(read(since), new Map()).map((e) => e.text)).toEqual([
    "[photo]",
    "[pdf plan R19.pdf]",
    "[photo, not on this Mac]",
    "https://example.com",
  ]);
});
