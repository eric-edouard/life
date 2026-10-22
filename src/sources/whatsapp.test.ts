import { expect, test } from "bun:test";
import { join } from "node:path";
import { showFiles } from "../memory/files";
import { whatsappFixture } from "./fixtures";
import { copyWhatsapp, readWhatsapp } from "./whatsapp";

test("media rows are files: the archive's copy, a document's name, a photo never downloaded", () => {
  const { add, dir, now, source } = whatsappFixture();
  add(1, "P1", 1, null, 300, "Media/120@g.us/a/photo.jpg");
  add(2, "D1", 8, "plan R19.pdf", 200, "Media/120@g.us/b/doc.pdf");
  add(3, "P2", 1, null, 100);
  // A link's media is its preview, not a file.
  add(4, "L1", 7, "https://example.com", 50, "Media/120@g.us/c/preview.jpg");
  copyWhatsapp(source, dir, now);
  const read = (d: Date) => readWhatsapp(d, dir, source);
  const since = new Date(now - 3_600_000);
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

  const events = readWhatsapp(new Date(now - 3_600_000), dir, source);
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
