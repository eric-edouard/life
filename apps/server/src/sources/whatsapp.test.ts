import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { proto, whatsappFixture } from "./store-fixtures";
import { copyWhatsapp, phoneCallOf, readWhatsapp } from "./whatsapp";

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
