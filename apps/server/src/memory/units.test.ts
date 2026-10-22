import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendJsonl } from "../core/files";
import { AGENT_WORD } from "../core/names";
import { readSettings, setSettings } from "../core/settings";
import { Imported } from "../records/observation";
import type { SourceEvent } from "../records/source";
import type { Person } from "../records/truth";
import type { Unit } from "../records/unit";
import { readAssistant } from "../sources/assistants";
import {
  apply,
  type LifelogChapter,
  type LifelogConversation,
  readConversations,
} from "../sources/lifelog";
import { copyNotes, readNotes } from "../sources/notes";
import {
  chapter,
  claudeExport,
  conversation as feedConversation,
  lifelogStore,
  noteData,
  notesFixture,
  page,
  run,
} from "../sources/store-fixtures";
import { showFiles } from "./attachments";
import { LIFE_MAIL } from "./email";
import { IMPORTED, keptConversations, readUnits, UNITS } from "./ledger";
import { loadTruth } from "./read-truth";
import { SOURCES } from "./sources";
import {
  applyRules,
  dayRange,
  daysBefore,
  gather,
  LIFE_CHAT,
  lastDays,
  lifelogUnits,
  MARKED,
  messageUnits,
  normalizeTopics,
  oneToOne,
  repoUnits,
  speakerOf,
  syncLifelogUnits,
  unitId,
  writeUnits,
} from "./units";
import { resolver, unitNow } from "./who";
import { chatLines } from "./words";
import { cutAt, dayStart, firstZoneDay, localDate, zoneAt } from "./zones";

const people = [
  {
    aliases: ["Jean"],
    handles: { email: [], phone: [], whatsapp: ["+33600000001"] },
    id: "me",
    name: "Jean Dupont",
    projects: [],
  },
  {
    aliases: ["Pops", "Jean Senior"],
    handles: {
      email: ["dad@example.com"],
      phone: [],
      whatsapp: ["+33600000002"],
    },
    id: "dad",
    name: "Jean Senior Dupont",
    projects: [],
  },
] as Person[];

const UNIT_ID = /^u_[0-9a-f]{12}$/;

const msg = (over: Partial<SourceEvent>): SourceEvent => ({
  at: "2026-10-09T10:00:00.000Z",
  chat: "!chat:beeper",
  chatName: "Dad",
  fromMe: false,
  id: "beeper:!chat/1",
  sender: "+33600000002",
  source: "beeper",
  text: "Can you call the plumber today?",
  ...over,
});

const conversation: LifelogConversation = {
  chapters: [
    {
      end: "2026-10-09T10:20:00.000Z",
      id: "chapter-1",
      items: 10,
      people: ["Jean (Me)", "Gaston"],
      ref: "job-1:0@2026-10-09T10:00:00.000Z",
      start: "2026-10-09T10:00:00.000Z",
      summary: "Jean and Gaston list the shop repairs.",
      title: "Shop repairs",
    },
    {
      end: "2026-10-09T10:40:00.000Z",
      id: "chapter-2",
      items: 11,
      people: [],
      ref: "job-1:10@2026-10-09T10:20:00.000Z",
      start: "2026-10-09T10:20:00.000Z",
      summary: "Customers ask about stencils.",
      title: "Counter talk",
    },
  ],
  endedAt: "2026-10-09T10:40:00.000Z",
  id: "00000000-0000-8000-8000-01a1210b4bdf",
  startedAt: "2026-10-09T10:00:00.000Z",
  state: "summarized",
  title: "At the shop",
};

test("unit ids are stable and hashes follow the content", () => {
  const [a] = messageUnits([msg({})], () => null);
  const [b] = messageUnits([msg({})], () => null);
  const [edited] = messageUnits(
    [msg({ text: "Call the plumber tomorrow" })],
    () => null
  );
  expect(a?.unit.id).toMatch(UNIT_ID);
  expect(a?.unit.id).toBe(b?.unit.id as string);
  expect(a?.unit.hash).toBe(b?.unit.hash as string);
  expect(edited?.unit.id).toBe(a?.unit.id as string);
  expect(edited?.unit.hash).not.toBe(a?.unit.hash as string);
  expect(unitId("x", "y")).not.toBe(unitId("x", "z"));
});

test("a chat-day groups one chat's messages of one day, names known senders in its text, keeps its senders unresolved and only refs", () => {
  const handles = (s: string) => (s === "+33600000002" ? "person:dad" : null);
  const built = messageUnits(
    [
      msg({ id: "beeper:!chat/1" }),
      msg({
        at: "2026-10-09T11:00:00.000Z",
        fromMe: true,
        id: "beeper:!chat/2",
        sender: "me",
        text: "Yes, at 5",
      }),
      msg({
        at: "2026-10-12T11:00:00.000Z",
        id: "beeper:!chat/3",
        text: "Thanks",
      }),
    ],
    handles
  );
  expect(built).toHaveLength(2);
  const day = built[0]?.unit;
  expect(day?.refs).toEqual(["beeper:!chat/1", "beeper:!chat/2"]);
  expect(day?.people).toEqual(["person:me", "unknown:+33600000002"]);
  expect(day?.stats).toEqual({ chars: 40, fromMe: 1, items: 2 });
  expect(day?.summary).toBeUndefined();
  expect(built[0]?.text).toContain("dad: Can you call the plumber today?");
});

test("a unit keeps its senders unresolved whoever they resolve to now (a reader maps them), a note's none, and its hash never moves", () => {
  const [unknown] = messageUnits([msg({})], () => null);
  const [known] = messageUnits([msg({})], () => "person:inf-plumber");
  const [mail] = messageUnits([msg({ source: "mail" })], () => null);
  const [note] = messageUnits([msg({ source: "notes" })], () => null);
  expect(known?.unit.people).toEqual(["unknown:+33600000002"]);
  expect(known?.text).toContain("inf-plumber: ");
  expect(mail?.unit.people).toEqual(["unknown:+33600000002"]);
  expect(note?.unit.people).toEqual([]);
  expect(known?.unit.hash).toBe(unknown?.unit.hash as string);
});

test("the same chat content seen twice hashes the same and the second unit is dropped as a duplicate", () => {
  const once = messageUnits(
    [msg({ chat: "+33600000002", id: "imessage:A", source: "imessage" })],
    () => null
  );
  const again = messageUnits([msg({})], () => null);
  const [first, second] = applyRules([...once, ...again]);
  expect(first?.unit.drop).toBeUndefined();
  expect(second?.unit.drop).toBe("duplicate");
});

test("lifelog chapters become units with lifelog's summary, turn refs and its names unresolved", () => {
  const units = lifelogUnits([conversation]).map((b) => b.unit);
  expect(units).toHaveLength(2);
  expect(units[0]?.refs).toEqual([
    "00000000-0000-8000-8000-01a1210b4bdf#chapter-1",
    "job-1:0@2026-10-09T10:00:00.000Z",
  ]);
  expect(units[0]?.id).toBe(unitId("lifelog", "chapter-1"));
  expect(units[0]?.stats.items).toBe(10);
  expect(units[0]?.people).toEqual(["unknown:Jean (Me)", "unknown:Gaston"]);
  expect(units[0]?.end).toBe("2026-10-09T10:20:00.000Z");
  expect(units[1]?.end).toBe(conversation.endedAt);
  expect(units[0]?.summary).toBe("Jean and Gaston list the shop repairs.");
  const unsummarized = lifelogUnits([
    { ...conversation, chapters: [], state: "transcribed" },
  ]);
  expect(applyRules(unsummarized)[0]?.unit.drop).toBe("no-summary");
});

test('a chapter he marked "hey Life" says so in its text, so only its hash moves, and keeps the marked refs', () => {
  const [plain, other] = lifelogUnits([conversation]);
  const [first] = conversation.chapters;
  const [marked, same] = lifelogUnits([
    {
      ...conversation,
      chapters: [
        { ...(first as LifelogChapter), marked: ["j:1@a"] },
        ...conversation.chapters.slice(1),
      ],
    },
  ]);
  expect(marked?.unit.marked).toEqual(["j:1@a"]);
  expect(marked?.text).toEndWith(MARKED);
  expect(marked?.unit.hash).not.toBe(plain?.unit.hash);
  expect(same?.unit.hash).toBe(other?.unit.hash);
});

test("names: aliases resolve, parentheses are ignored, a shared name resolves to nobody", () => {
  const resolve = resolver([
    ...people,
    { ...people[1], aliases: [], id: "other", name: "Pops" } as Person,
  ]);
  expect(resolve("Jean (Me)")).toBe("person:me");
  expect(resolve("Jean Senior")).toBe("person:dad");
  expect(resolve("Pops")).toBeNull();
});

test("the code rules drop login codes, newsletters and near-empty days, and keeps real messages", () => {
  const mail = (over: Partial<SourceEvent>, bulk: boolean) => ({
    ...msg({
      chat: "mail:7",
      chatName: "Weekly deals",
      id: "mail:x",
      sender: "news@shop.test",
      source: "mail",
      text: "Weekly deals\nBig sale on everything this week, up to 50% off.",
      ...over,
    }),
    bulk,
  });
  const built = applyRules([
    ...messageUnits(
      [
        msg({
          chat: "otp",
          id: "b:1",
          text: "Your verification code is 482913",
        }),
      ],
      () => null
    ),
    ...messageUnits([mail({}, true)], () => null),
    ...messageUnits(
      [
        mail(
          {
            chat: "mail:8",
            fromMe: true,
            id: "mail:y",
            text: "Re: Weekly deals\nPlease remove me.",
          },
          true
        ),
      ],
      () => null
    ),
    ...messageUnits(
      [
        mail(
          {
            chat: "mail:9",
            id: "mail:z",
            sender: "alerts@agents.example.test",
            text: "Bakery Ads report: approve 3 changes",
          },
          true
        ),
      ],
      () => null
    ),
    ...messageUnits(
      [msg({ chat: "short", id: "b:2", text: "ok" })],
      () => null
    ),
    ...messageUnits([msg({ chat: "real", id: "b:3" })], () => null),
    ...messageUnits([msg({ chat: LIFE_CHAT, id: "b:4" })], () => null),
  ]);
  expect(built.map((b) => b.unit.drop ?? null)).toEqual([
    "one-time-code",
    "newsletter",
    null,
    null,
    "too-short",
    null,
    "life-output",
  ]);
});

test("login-code mails and vendor notifications Jean never answered are dropped, unless they carry bad news; his agents' reports are kept, Life's own mail is not", () => {
  const mail = (id: string, sender: string, title: string, text: string) =>
    msg({
      chat: id,
      chatName: title,
      id,
      sender,
      source: "mail",
      text: `${title}\n${text}`,
    });
  const built = applyRules(
    messageUnits(
      [
        mail(
          "m1",
          "no-reply@togo.test",
          "Code de vérification - TOGO",
          "Saisissez ce code pour vous identifier\n7 4 7 3 0 0\nCe code est personnel."
        ),
        mail(
          "m2",
          "no-reply@vendor.test",
          "Your receipt",
          "Thanks for your purchase, see your receipt in the app."
        ),
        mail(
          "m3",
          "no-reply@vendor.test",
          "Payment failed",
          "We could not charge your card; your service will be suspended."
        ),
        mail(
          "m4",
          LIFE_MAIL.from as string,
          "Bakery · 18 oct. — the shop slips again",
          "Two forward bookings are inactive."
        ),
        mail(
          "m6",
          LIFE_MAIL.from as string,
          "Life · 17 Oct · 108 new facts, 20 pages",
          "Facts: Jean must pay the cladding deposit."
        ),
        mail(
          "m5",
          "marie@example.test",
          "Dinner",
          "Are you free on Friday evening?"
        ),
      ],
      () => null
    )
  );
  expect(built.map((b) => b.unit.drop ?? null)).toEqual([
    "one-time-code",
    "automated",
    null,
    null,
    "life-output",
    null,
  ]);
});

test("a 1:1 chat's title names its unknown member; a group or a mail thread names nobody", () => {
  const handles = () => null;
  const [one] = messageUnits(
    [msg({ chatName: "Anne-Sophie", sender: "@line_x:beeper.local" })],
    handles
  );
  expect(one && oneToOne(one)).toBe("Anne-Sophie");
  const [group] = messageUnits(
    [
      msg({ chatName: "Builders", sender: "+66000000001" }),
      msg({
        chatName: "Builders",
        id: "beeper:!chat/2",
        sender: "+66000000002",
      }),
    ],
    handles
  );
  expect(group && oneToOne(group)).toBeUndefined();
  const [mail] = messageUnits(
    [msg({ chatName: "Invoice", sender: "a@b.c", source: "mail" })],
    handles
  );
  expect(mail && oneToOne(mail)).toBeUndefined();
});

test("a date range is whole local days, the last one included; instants stay as given", () => {
  const { from, to } = dayRange("2026-10-14", "2026-10-14");
  expect(new Date(to ?? "").getTime() - new Date(from ?? "").getTime()).toBe(
    86_400_000
  );
  // He was in Berlin (memory/zones.jsonl).
  expect(from).toBe("2026-10-13T22:00:00.000Z");
  expect(dayRange("2026-10-14T08:00:00Z").from).toBe(
    "2026-10-14T08:00:00.000Z"
  );
  // The end never passes now.
  const now = Date.now();
  expect(dayRange().from).toBeUndefined();
  expect(Date.parse(dayRange(undefined, "2999-01-01").to ?? "")).toBeLessThan(
    now + 60_000
  );
});

test("a repo-day is a unit: commits and lines in the title, the subjects as summary, other authors by name", () => {
  const commit = (n: number, over: Partial<SourceEvent>): SourceEvent => ({
    added: 100,
    at: `2026-10-09T1${n}:00:00.000Z`,
    chat: "photo-app",
    chatName: "photo-app",
    fromMe: true,
    id: `git:photo-app/${n}`,
    removed: 20,
    sender: "owner@example.com",
    source: "git",
    text: `Change ${n}`,
    ...over,
  });
  const [b] = repoUnits([
    commit(1, {}),
    commit(2, { fromMe: false, sender: "Jérôme" }),
    commit(3, { fromMe: false, sender: "Jérôme" }),
  ]);
  expect(b?.unit).toMatchObject({
    id: unitId("git", "photo-app", "2026-10-09"),
    key: "photo-app",
    source: "git",
    stats: {
      added: 300,
      fromMe: 1,
      items: 3,
      others: { Jérôme: 2 },
      removed: 60,
    },
    summary: "Change 1; Change 2; Change 3",
    title: "photo-app: 3 commits (2 by others), +300 −60",
  });
  expect(b?.unit.refs).toEqual(["git:photo-app/1", "git:photo-app/3"]);
});

test("a window is whole local days where he was, today included", () => {
  // 11 Oct in Berlin; 5 Oct began in Jakarta (UTC+7).
  const w = lastDays(new Date("2026-10-11T12:30:00Z"), 7);
  expect(w).toEqual({ from: "2026-10-05", to: "2026-10-11" });
  expect(dayStart(w.from).toISOString()).toBe("2026-10-04T17:00:00.000Z");
});

test("his zone at an instant is the latest record before it, the first one before them all, in time order", () => {
  // Lisbon from 2019 is the file's last line: his past, told after the newer records.
  expect(zoneAt("2018-01-01T00:00:00Z")).toBe("Europe/Lisbon");
  // A backfill may not start before it.
  expect(firstZoneDay()).toBe("2019-01-01");
  expect(zoneAt("2020-01-01T00:00:00Z")).toBe("Europe/Lisbon");
  expect(zoneAt("2026-08-02T00:00:00Z")).toBe("Asia/Jakarta");
  expect(zoneAt("2026-10-06T16:59:59Z")).toBe("Asia/Jakarta");
  expect(zoneAt("2026-10-06T17:00:00Z")).toBe("Europe/Berlin");
  expect(zoneAt("2030-01-01T00:00:00Z")).not.toBe("Asia/Jakarta");
  // The day he flew to Germany lasts until Berlin midnight: no hour of it is lost.
  expect(dayStart("2026-10-06").toISOString()).toBe("2026-10-05T17:00:00.000Z");
  expect(dayStart("2026-10-07").toISOString()).toBe("2026-10-06T22:00:00.000Z");
});

test("a move takes effect at once on a shared day, else at the next midnight of the zone ahead, so days never go back", () => {
  const noon = new Date("2026-11-02T10:00:00Z");
  expect(cutAt(noon, "Asia/Jakarta", "Europe/Berlin")).toEqual(noon);
  // 20:00Z: 3 Nov 03:00 in Jakarta, 2 Nov 21:00 in Berlin. Either way, Jakarta's 4 Nov starts it.
  const late = new Date("2026-11-02T20:00:00Z");
  expect(cutAt(late, "Asia/Jakarta", "Europe/Berlin").toISOString()).toBe(
    "2026-11-03T17:00:00.000Z"
  );
  expect(cutAt(late, "Europe/Berlin", "Asia/Jakarta").toISOString()).toBe(
    "2026-11-03T17:00:00.000Z"
  );
});

test("a day read again in another country keeps its local dates, times and unit ids", () => {
  const was = process.env.TZ;
  const cases = [
    // A Berlin evening past local midnight, rebuilt with the Mac in Lagos (UTC+1 there).
    ["2026-10-15T22:30:00.000Z", "2026-10-16", "00:30"],
    // A Jakarta night in September, rebuilt from Germany or Nigeria.
    ["2026-09-15T18:30:00.000Z", "2026-09-16", "01:30"],
  ];
  try {
    for (const [at = "", date, clock] of cases) {
      const built = ["Europe/Berlin", "Africa/Lagos", "Asia/Jakarta"].map(
        (tz) => {
          process.env.TZ = tz;
          const [b] = messageUnits(
            [msg({ at, source: "whatsapp" })],
            () => null
          );
          return { date: b?.unit.date, id: b?.unit.id, line: b?.text };
        }
      );
      for (const b of built) {
        expect(b).toEqual({
          date,
          id: unitId("whatsapp", "!chat:beeper", date ?? ""),
          line: `Dad\n${clock} +33600000002: Can you call the plumber today?`,
        });
      }
    }
  } finally {
    if (was === undefined) {
      delete process.env.TZ;
    } else {
      process.env.TZ = was;
    }
  }
});

test("topics are lower case, singular where trivial, dashed, at most three, no repeats", () => {
  expect(
    normalizeTopics([
      "Philosophy",
      " AI ",
      "Constructions",
      "family money",
      "Families",
      "news",
      "philosophy",
      "Taxes",
    ])
  ).toEqual(["philosophy", "ai", "construction"]);
  expect(
    normalizeTopics(["family money", "Families", "news", "Taxes"])
  ).toEqual(["family-money", "family", "news"]);
  expect(normalizeTopics(null)).toEqual([]);
});

test("a lifelog chapter that moves to another day leaves its old day's file; other sources' units in that file stay", async () => {
  expect(existsSync(UNITS)).toBe(false); // test data has no units: this test makes and removes them
  const chat: Unit = {
    date: "2026-10-14",
    end: "2026-10-14T09:00:00.000Z",
    hash: "0123456789abcdef",
    id: "u_00000000000a",
    key: "120@g.us",
    people: [],
    refs: ["whatsapp:120@g.us/1"],
    schemaVersion: 1,
    source: "whatsapp",
    start: "2026-10-14T09:00:00.000Z",
    stats: { chars: 40, fromMe: 1, items: 1 },
    title: "Team",
  };
  const store = lifelogStore();
  const on = (day: string) =>
    page({
      chapters: [chapter("a", `${day}T10:00:00.000Z`, `${day}T10:05:00.000Z`)],
      conversations: [
        feedConversation("c1", {
          endAt: `${day}T10:10:00.000Z`,
          startAt: `${day}T10:00:00.000Z`,
        }),
      ],
    });
  const days = async () =>
    Object.fromEntries(
      Map.groupBy(await readUnits(), (u) => u.date)
        .entries()
        .map(([d, us]) => [d, us.map((u) => u.source)])
    );
  try {
    await writeUnits([chat.date], [chat]);
    apply(store, on("2026-10-14"));
    await syncLifelogUnits(store);
    expect(await days()).toEqual({ "2026-10-14": ["whatsapp", "lifelog"] });
    apply(store, on("2026-10-15"));
    expect(await syncLifelogUnits(store)).toMatchObject({ changed: 1 });
    expect(await days()).toEqual({
      "2026-10-14": ["whatsapp"],
      "2026-10-15": ["lifelog"],
    });
    // A night that could not read WhatsApp (its access gone) rewrites the day without losing its units.
    const mail = { ...chat, id: "u_00000000000b", source: "mail" as const };
    await writeUnits([chat.date], [mail], (u) => u.source === "whatsapp");
    expect(await days()).toMatchObject({ "2026-10-14": ["whatsapp", "mail"] });
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
  }
});

test("a conversation from 23:40 to 00:30 at the window start is read whole: its 00:10 chapter is on the window's first day", () => {
  // Berlin, UTC+2: 23:40 on the 14th is 21:40Z, the window starts at 00:00 on the 15th (22:00Z).
  const store = lifelogStore();
  apply(
    store,
    page({
      chapters: [
        chapter("a", "2026-10-14T21:40:00.000Z", "2026-10-14T22:10:00.000Z"),
        chapter("b", "2026-10-14T22:10:00.000Z", "2026-10-14T22:30:00.000Z"),
      ],
      conversations: [
        feedConversation("c1", {
          endAt: "2026-10-14T22:30:00.000Z",
          startAt: "2026-10-14T21:40:00.000Z",
        }),
      ],
    })
  );
  expect(
    lifelogUnits(readConversations(store, dayStart("2026-10-15"))).map((b) => [
      b.unit.date,
      b.unit.start,
    ])
  ).toEqual([
    ["2026-10-14", "2026-10-14T21:40:00.000Z"],
    ["2026-10-15", "2026-10-14T22:10:00.000Z"],
  ]);
});

test("who wrote a message, for every kind: him, an agent's own line, whom the resolver names, else unknown", () => {
  const named = (s: string) => (s === "+33600000002" ? "person:dad" : null);
  const of = (
    kind: Parameters<typeof speakerOf>[0],
    sender: string,
    fromMe = false
  ) => speakerOf(kind, { fromMe, sender }, named);
  expect([
    of("chat", "me", true),
    of("chat", "+33600000002"),
    of("mail", "a@b.c"),
    of("agent", AGENT_WORD),
    of("agent", "+33600000002"),
  ]).toEqual([
    "person:me",
    "person:dad",
    "unknown:a@b.c",
    `agent:${AGENT_WORD}`,
    "agent:+33600000002",
  ]);
});

test("a reader sees a unit's stored senders as whom they resolve to today, a mail's unknown senders left out", () => {
  const resolve = resolver(people);
  const refOf = (r: string) =>
    r.startsWith("unknown:") ? (resolve(r.slice(8)) ?? r) : r;
  const [chat] = messageUnits(
    [msg({}), msg({ id: "b:2", sender: "+66600000009" })],
    () => null
  );
  const [mail] = messageUnits(
    [msg({ sender: "news@shop.example", source: "mail" })],
    () => null
  );
  expect(chat && unitNow(chat.unit, refOf).people).toEqual([
    "person:dad",
    "unknown:+66600000009",
  ]);
  expect(mail && unitNow(mail.unit, refOf).people).toEqual([]);
});

test("with no source turned on, a sweep reads nothing and fails nothing", async () => {
  const before = readSettings().sources;
  try {
    setSettings({ sources: [] });
    const e = await gather(
      { from: "2026-10-20", to: "2026-10-21" },
      { resolve: () => null, truth: await loadTruth() }
    );
    expect(e.built).toEqual([]);
    expect(e.conversations).toEqual([]);
    expect(e.failed).toEqual([]);
  } finally {
    setSettings({ sources: before });
  }
});

test("a source turned on that can't be read now is skipped, by name, never a failure", async () => {
  const before = readSettings().sources;
  const unreadable = SOURCES.find((s) => s.missing?.());
  if (!unreadable) {
    throw new Error("the test data has no source that can't be read");
  }
  try {
    setSettings({ sources: [unreadable.name] });
    const e = await gather(
      { from: "2026-10-20", to: "2026-10-21" },
      { resolve: () => null, truth: await loadTruth() }
    );
    expect(e.skipped).toEqual([unreadable.name]);
    expect(e.failed).toEqual([]);
  } finally {
    setSettings({ sources: before });
  }
});

test("his pruned messages are read; only the conversations the import kept become memory", () => {
  const dir = mkdtempSync(join(tmpdir(), "assistants-"));
  const path = join(dir, "conversations.json");
  writeFileSync(path, JSON.stringify(claudeExport));
  const events = readAssistant("claude")(new Date(0), path);
  // c2 was all code: pruned before anything judged it.
  expect(
    events.map((e) => [e.id, e.chat, e.chatName, e.fromMe, e.sender])
  ).toEqual([
    ["claude:c1/m1", "claude:c1", "Chat with Claude: Ada's move", true, "me"],
    ["claude:c1/m3", "claude:c1", "Chat with Claude: Ada's move", true, "me"],
  ]);
  expect(
    readAssistant("claude")(new Date("2026-03-02T09:16:00.000Z"), path).length
  ).toBe(1);
  // One unit per conversation and local day, dropped until the import keeps it.
  const unit = () =>
    applyRules(
      messageUnits(events, () => null),
      keptConversations()
    )[0]?.unit;
  expect([unit()?.source, unit()?.key, unit()?.drop]).toEqual([
    "claude",
    "claude:c1",
    "not-kept",
  ]);
  appendJsonl(IMPORTED, Imported, [
    {
      at: "2026-10-21T00:00:00.000Z",
      conversation: "claude:c1",
      keep: true,
      madeBy: { engine: "codex", model: "m", prompt: "import.v1", run: "r" },
      schemaVersion: 1,
      why: "His sister's move.",
    },
  ]);
  expect(unit()?.drop).toBeUndefined();
});

test("two saves in a day are one unit of two lines, the same read from its start; files only where added, Apple's text of a table", () => {
  const { db, dir, now, save, source } = notesFixture();
  db.run(`insert into ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZTYPEUTI, ZMEDIA, ZSUMMARY) values
    (20, 5, 'A1', 'public.jpeg', 21, null), (22, 5, 'T1', 'com.apple.notes.table', null, 'Day Cost Mon 12')`);
  db.run(`insert into ZICCLOUDSYNCINGOBJECT (Z_PK, Z_ENT, ZIDENTIFIER, ZFILENAME, ZACCOUNT6) values
    (21, 11, 'M1', 'IMG_1.jpeg', 103)`);
  const yesterday = dayStart(
    daysBefore(localDate(new Date(now).toISOString()), 1)
  );
  const agoS = (hour: number) =>
    (now - yesterday.getTime()) / 1000 - hour * 3600;
  const body = (text: string) =>
    noteData(`${text}\n￼￼`, [
      run(text.length + 1),
      run(1, { attachment: "A1" }),
      run(1, { attachment: "T1" }),
    ]);
  save(1, body("Budget"), { agoS: agoS(10) });
  copyNotes(source, dir, now);
  save(1, body("Budget\nRent paid"), { agoS: agoS(11) });
  copyNotes(source, dir, now);
  const events = readNotes(yesterday, dir);
  expect(events.map((e) => e.files)).toEqual([
    [{ mime: "image/jpeg", name: "IMG_1.jpeg", ref: "notes:A1" }],
    [],
  ]);
  const units = (since: Date) =>
    messageUnits(showFiles(readNotes(since, dir), new Map()), () => null);
  const built = units(yesterday);
  expect(built.map((b) => b.messages.map((m) => m.text))).toEqual([
    [
      "Budget\n[attachment: Day Cost Mon 12]\n[photo IMG_1.jpeg, not on this Mac]",
      "+ Rent paid",
    ],
  ]);
  const unit = built.map((b) => b.unit);
  expect(units(new Date(unit[0]?.start ?? "")).map((b) => b.unit)).toEqual(
    unit
  );
});

test("deletions on two days are two units, and a restore is dated when seen and read against the last live text", () => {
  const { db, dir, now, save, source } = notesFixture();
  const day = 86_400_000;
  for (const pk of [1, 2, 3]) {
    save(pk, noteData(`Note text ${pk}`), { agoS: 5 * 86_400 });
  }
  copyNotes(source, dir, now - 3 * day);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK = 1");
  copyNotes(source, dir, now - 2 * day);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK = 2");
  copyNotes(source, dir, now - day);
  save(1, noteData("Note text 1\nback"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now);
  const built = applyRules(
    messageUnits(
      showFiles(readNotes(new Date(now - 2.5 * day), dir), new Map()),
      () => null
    )
  );
  expect(built.map((b) => [b.unit.drop, b.messages[0]?.text])).toEqual([
    [undefined, "[deleted the note Note 1]"],
    [undefined, "[deleted the note Note 2]"],
    [undefined, "[restored the note Note 1]\n+ back"],
  ]);
  expect(built.at(-1)?.unit.start).toBe(new Date(now).toISOString());
});

test("two notes restored unchanged on two days are two units", () => {
  const { db, dir, now, save, source } = notesFixture();
  const day = 86_400_000;
  for (const pk of [1, 2, 3]) {
    save(pk, noteData(`Note text ${pk}`), { agoS: 5 * 86_400 });
  }
  copyNotes(source, dir, now - 4 * day);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK in (1, 2)");
  copyNotes(source, dir, now - 3 * day);
  save(1, noteData("Note text 1"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now - 2 * day);
  save(2, noteData("Note text 2"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now - day);
  const built = applyRules(
    messageUnits(
      showFiles(readNotes(new Date(now - 2.5 * day), dir), new Map()),
      () => null
    )
  );
  expect(built.map((b) => [b.unit.drop, b.messages[0]?.text])).toEqual([
    [undefined, "[restored the note Note 1]"],
    [undefined, "[restored the note Note 2]"],
  ]);
});

test("a shared note's lines are never his: extract reads them as an unknown speaker", () => {
  const { dir, now, save, source } = notesFixture();
  save(1, noteData("Groceries for the flat"), { shared: true });
  copyNotes(source, dir, now);
  const [unit] = messageUnits(
    readNotes(new Date(now - 3_600_000), dir),
    () => null
  );
  expect(unit && chatLines(unit, () => null).map((l) => l.speaker)).toEqual([
    "unknown:shared note",
  ]);
  expect(unit?.unit.stats.fromMe).toBe(0);
});
