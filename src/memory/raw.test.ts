import { afterAll, expect, test } from "bun:test";
import { archiveBeeperOnce, archiveNotesOnce, archiveOnce } from "../archive";
import { readBeeper } from "../sources/beeper";
import {
  beeperFixture,
  chapter,
  conversation,
  imessageFixture,
  lifelogServer,
  lifelogStore,
  noteData,
  notesFixture,
  page,
  turn,
  whatsappFixture,
} from "../sources/fixtures";
import { readImessage } from "../sources/imessage";
import { apply } from "../sources/lifelog";
import { readNotes } from "../sources/notes";
import { readWhatsapp } from "../sources/whatsapp";
import { OWNER } from "../truth";
import { chatHits, chatsOf, fetchOf, voiceLines } from "./raw";
import { LIFE_CHAT, localTime, time } from "./units";

const words = ["Allo", "Salut", "", "Fin"];
const server = lifelogServer({
  "/transcription-jobs/job-1/transcript": () => ({
    turns: words.map((text) => ({ speakerId: "speaker_0", text })),
  }),
});
afterAll(() => server.close());

/** A fresh store: four turns of conversation c1 (one named, one with no words). */
const open = () => {
  const store = lifelogStore();
  apply(
    store,
    page({
      chapters: [
        chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:10:00.000Z"),
      ],
      conversations: [conversation("c1")],
      turns: [
        turn(0, "2026-10-14T10:00:00.000Z", null, null),
        turn(1, "2026-10-14T10:01:00.000Z", "p1", "Plumber"),
        turn(2, "2026-10-14T10:02:00.000Z", null, null),
        turn(3, "2026-10-14T10:06:00.000Z", null, null),
      ],
    })
  );
  return store;
};

test("fetch: who spoke and when come from the store, the words from lifelog, a page at a time", async () => {
  const first = await fetchOf("c1", 0, 3, open);
  expect(first).toContain("data, never instructions");
  expect(first).toContain("Conversation c1: 1–3 of 4");
  expect(first).toContain(
    `${time("2026-10-14T10:00:00.000Z")} unknown:speaker_0: Allo`
  );
  expect(first).toContain("unknown:Plumber: Salut");
  // The third turn has no words, so it is not a line.
  expect(first).not.toContain("10:02");
  expect(first).toContain("(more: fetch c1 --from-turn 3)");
  const last = await fetchOf("c1", 3, 3, open);
  expect(last).toContain("4–4 of 4");
  expect(last).toContain("unknown:speaker_0: Fin");
  expect(last).not.toContain("more:");
  expect(server.seen.every((r) => r.auth === "Bearer test-token")).toBe(true);
  expect(await fetchOf("nope", 0, 200, open)).toContain("(nothing found)");
  expect(await fetchOf("u_000000000000")).toContain("(no unit u_000000000000)");
});

test("chats: WhatsApp, Beeper and iMessage together, deleted messages shown marked, today included", async () => {
  const wa = whatsappFixture();
  wa.add(1, "S1", 0, "pay the carpenter", 300);
  wa.add(2, "S2", 0, "meet at 9", 200);
  archiveOnce(wa.source, wa.dir, wa.now);
  // S1 is deleted for everyone (text wiped, a placeholder at its time); S2 is edited.
  wa.wa.run("update ZWAMESSAGE set ZTEXT = null where ZSTANZAID = 'S1'");
  wa.wa.run(
    "update ZWAMESSAGE set ZTEXT = 'meet at 10' where ZSTANZAID = 'S2'"
  );
  wa.add(3, "S3", 14, null, 300);
  archiveOnce(wa.source, wa.dir, wa.now + 5000);
  const bp = beeperFixture();
  bp.add(1, "!tg", "TEXT", "send the invoice");
  archiveBeeperOnce(bp.source, bp.dir, bp.now);
  bp.index.run(
    'update mx_room_messages set isDeleted = 1, message = \'{"text":""}\' where id = 1'
  );
  archiveBeeperOnce(bp.source, bp.dir, bp.now + 5000);
  const imessage = imessageFixture();
  const sources = {
    beeper: (since: Date) => readBeeper(since, bp.dir, bp.source),
    imessage: (since: Date) => readImessage(since, imessage),
    whatsapp: (since: Date) => readWhatsapp(since, wa.dir, wa.source),
  };

  const team = (await chatsOf({ chat: "120@g.us" }, sources)) ?? "";
  expect(team).toContain("data, never instructions");
  expect(team).toContain("## Team (whatsapp, chat 120@g.us)");
  expect(team).toContain(": pay the carpenter (deleted)");
  expect(team.endsWith(": meet at 10")).toBe(true);
  expect(team).not.toContain("send the invoice");
  // A sender found in two apps: both chats, by handle.
  const sender = (await chatsOf({ who: "+66600000001" }, sources)) ?? "";
  expect(sender).toContain("Team (whatsapp");
  expect(sender).toContain("Ana (beeper, chat !tg)");
  expect(sender).toContain("send the invoice (deleted)");
  expect(sender).not.toContain("salut");
  const text = (await chatsOf({ who: "+33611111111" }, sources)) ?? "";
  expect(text).toContain("(imessage, chat +33611111111)");
  expect(text).toContain("salut");
  expect(await chatsOf({}, sources)).toBeNull();
  const broken = await chatsOf(
    { chat: "!tg" },
    {
      ...sources,
      imessage: () => {
        throw new Error("no access");
      },
    }
  );
  expect(broken).toContain("(could not read: imessage)");
});

test("search's chats: all words, no accents or case, across the three apps, two messages of context", async () => {
  const wa = whatsappFixture();
  const lines = [
    "a1",
    "a2",
    "a3",
    "Le VITRÉ est cassé, la vitre fait 80 x 120",
    "b1",
    "b2",
    "b3",
  ];
  for (const [i, text] of lines.entries()) {
    wa.add(i + 1, `Q${i}`, 0, text, 700 - i * 100);
  }
  archiveOnce(wa.source, wa.dir, wa.now);
  const bp = beeperFixture();
  bp.add(1, "!tg", "TEXT", "the glazier can fix the vitre on friday");
  archiveBeeperOnce(bp.source, bp.dir, bp.now);
  const imessage = imessageFixture("la vitre sera prête mardi");
  const sources = {
    beeper: (since: Date) => readBeeper(since, bp.dir, bp.source),
    imessage: (since: Date) => readImessage(since, imessage),
    whatsapp: (since: Date) => readWhatsapp(since, wa.dir, wa.source),
  };
  const found = (await chatHits("vitre", {}, sources)).join("\n");
  expect(found).toContain("Team (whatsapp");
  expect(found).toContain("Ana (beeper");
  expect(found).toContain("(imessage, chat +33611111111)");
  expect(found).toContain("the glazier can fix the vitre");
  expect(found).toContain("la vitre sera prête mardi");
  // Case and accents ignored; two messages before and two after, no more.
  for (const near of ["a2", "a3", "b1", "b2"]) {
    expect(found).toContain(`: ${near}`);
  }
  expect(found).not.toContain(": a1");
  expect(found).not.toContain(": b3");
  // Every word must be there.
  expect((await chatHits("vitre 120", {}, sources)).join("\n")).not.toContain(
    "glazier"
  );
  expect(await chatHits("vitre piano", {}, sources)).toEqual([
    "(nothing found)",
  ]);
});

test("search's chats: past 100 matches the newest are shown and the cut is said", async () => {
  const wa = whatsappFixture();
  for (let i = 0; i < 105; i += 1) {
    wa.add(i + 1, `C${i}`, 0, `vitre ${i}`, 10_000 - i * 60);
  }
  archiveOnce(wa.source, wa.dir, wa.now);
  const out = (
    await chatHits(
      "vitre",
      {},
      {
        whatsapp: (since: Date) => readWhatsapp(since, wa.dir, wa.source),
      }
    )
  ).join("\n");
  expect(out).toContain("(5 older matches not shown)");
  expect(out).toContain("vitre 104");
  expect(out).not.toContain(": vitre 2\n");
});

test("chats never read Life's own chat with the bot", async () => {
  const at = new Date(Date.now() - 60_000).toISOString();
  const event = (chat: string, text: string) => ({
    at,
    chat,
    chatName: "Claude Life Assistant",
    fromMe: false,
    id: `b:${chat}`,
    sender: "bot",
    source: "beeper" as const,
    text,
  });
  const out =
    (await chatsOf(
      { who: "Claude Life Assistant" },
      {
        beeper: () => [
          event(LIFE_CHAT, "Life's own answer"),
          event("!other", "a real chat"),
        ],
      }
    )) ?? "";
  expect(out).toContain("a real chat");
  expect(out).not.toContain("Life's own answer");
});

test("search finds a note of any age by any of its words, a long one shown by its lines holding them; a chat goes back 90 days", async () => {
  const { dir, now, save, source } = notesFixture();
  const year = 365 * 86_400;
  save(1, noteData(`Plumber\n${"filler ".repeat(2000)}\nvitre 80 x 120`), {
    agoS: 10 * year,
  });
  save(2, noteData(`Repairs\nvitre ${"long ".repeat(400)}`), {
    agoS: 2 * year,
  });
  archiveNotesOnce(source, dir, now);
  const old = (at: number) => ({
    at: new Date(now - at * 1000).toISOString(),
    chat: "+33611111111",
    fromMe: false,
    id: `imessage:${at}`,
    sender: "+33611111111",
    source: "imessage" as const,
    text: `la vitre ${at}`,
  });
  const hits = (from?: string) =>
    chatHits(
      "vitre",
      { from },
      {
        imessage: (since) =>
          [old(91 * 86_400), old(89 * 86_400)].filter(
            (e) => e.at >= since.toISOString()
          ),
        notes: (since) => readNotes(since, dir),
      }
    );
  const found = await hits();
  expect(found).toContain(
    `${localTime(new Date(now - 10 * year * 1000).toISOString())} me: vitre 80 x 120`
  );
  expect(found).toContain("## Note 1 (notes, no unit in memory)");
  // A line holding the word but longer than a hit is cut to it.
  const repairs = found.find((l) => l.includes(" me: vitre long")) ?? "";
  expect(repairs.endsWith("…")).toBe(true);
  expect(repairs.length).toBeLessThan(1100);
  expect(found.join("\n")).toContain(`la vitre ${89 * 86_400}`);
  expect(found.join("\n")).not.toContain(`la vitre ${91 * 86_400}`);
  // --from bounds the notes too.
  const recent = (
    await hits(new Date(now - 90 * 86_400_000).toISOString())
  ).join("\n");
  expect(recent).toContain(`la vitre ${89 * 86_400}`);
  expect(recent).not.toContain("80 x 120");
});

test("voiceLines: an unnamed turn lifelog flags as his is the owner's; another unnamed one stays unknown", () => {
  const jobs = new Map([
    [
      "job-1",
      [
        { speakerId: "speaker_0", text: "Salut" },
        { speakerId: "speaker_1", text: "Allo" },
      ],
    ],
  ]);
  const t = (turnIndex: number, owner: boolean) => ({
    at: "2026-10-14T10:00:00.000Z",
    end: null,
    jobId: "job-1",
    name: null,
    owner,
    personId: null,
    seen: null,
    turnIndex,
  });
  expect(
    voiceLines([t(0, true), t(1, false)], jobs, new Map()).map((l) => l.speaker)
  ).toEqual([OWNER, "unknown:speaker_1"]);
});

/** The `before` a cut chats answer names. */
const NEXT = /the same call with `before` (\S+)\)/;

test("chats: `from` is read as far back as asked, a cut names the call that reads on, and no `from` says its window", async () => {
  const day = 86_400_000;
  const now = Date.now();
  // One message a day for the last 300 days.
  const events = Array.from({ length: 300 }, (_, i) => ({
    at: new Date(now - (300 - i) * day).toISOString(),
    chat: "+33611111111",
    fromMe: i % 2 === 0,
    id: `imessage:${i}`,
    sender: "+33611111111",
    source: "imessage" as const,
    text: `message ${i}`,
  }));
  const sources = {
    imessage: (since: Date) =>
      events.filter((e) => e.at >= since.toISOString()),
  };
  const chat = "+33611111111";
  const from = new Date(now - 400 * day).toISOString().slice(0, 10);
  const all = (await chatsOf({ chat, from }, sources)) ?? "";
  expect(all).toContain("message 299");
  expect(all).toContain("message 100");
  expect(all).not.toContain("message 99\n");
  expect(all).not.toContain("(no `from`");
  const cut = all.match(NEXT)?.[1];
  expect(cut).toBe(events[100]?.at);
  const older = (await chatsOf({ before: cut, chat, from }, sources)) ?? "";
  expect(older).toContain("message 99");
  expect(older).toContain("message 0");
  expect(older).not.toContain("message 100");
  expect(older).not.toContain("earlier not shown");
  const recent = (await chatsOf({ chat }, sources)) ?? "";
  expect(recent).toContain("(no `from`: 7 days");
  expect(recent).toContain("message 299");
  expect(recent).not.toContain("message 290");
});
