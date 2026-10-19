import { expect, test } from "bun:test";
import type { FileEntry, SourceEvent, SourceFile } from "../schema";
import { showFiles, triage } from "./files";
import { digest } from "./ledger";
import { locate } from "./observe";

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
        photo("beeper:c", "/c.heic"),
        photo("beeper:gone"),
        { mime: "video/mp4", path: "/v.mp4", ref: "beeper:video" }
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
    [hashOf("beach"), ["whatsapp:chat/b", "beeper:c"]],
  ]);
});
