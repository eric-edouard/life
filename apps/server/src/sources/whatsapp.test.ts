import { expect, test } from "bun:test";
import { HOUR } from "../core/clock";
import { whatsappFixture } from "./store-fixtures";
import { copyWhatsapp, readWhatsapp } from "./whatsapp";

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
