import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { Person, SourceEvent, Unit } from "../schema";
import {
  chapter,
  conversation as feedConversation,
  lifelogStore,
  page,
} from "../sources/fixtures";
import {
  apply,
  type LifelogConversation,
  readConversations,
} from "../sources/lifelog";
import { LIFE_MAIL } from "./email";
import { readUnits, UNITS } from "./ledger";
import {
  applyRules,
  dayRange,
  LIFE_CHAT,
  lastDays,
  lifelogUnits,
  messageUnits,
  nameIndex,
  normalizeTopics,
  oneToOne,
  personRef,
  repoUnits,
  syncLifelogUnits,
  unitId,
  writeUnits,
} from "./units";
import { cutAt, dayStart, firstZoneDay, zoneAt } from "./zones";

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

test("a chat-day groups one chat's messages of one day, names known senders and keeps only refs", () => {
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
  expect(day?.people).toEqual(["person:dad", "person:me"]);
  expect(day?.stats).toEqual({ chars: 40, fromMe: 1, items: 2 });
  expect(day?.summary).toBeUndefined();
  expect(built[0]?.text).toContain("dad: Can you call the plumber today?");
});

test("a chat keeps a sender nobody resolves as unknown, a mail leaves it out, and who resolves never moves the hash", () => {
  const [unknown] = messageUnits([msg({})], () => null);
  const [known] = messageUnits([msg({})], () => "person:inf-plumber");
  const [mail] = messageUnits([msg({ source: "mail" })], () => null);
  expect(unknown?.unit.people).toEqual(["unknown:+33600000002"]);
  expect(known?.unit.people).toEqual(["person:inf-plumber"]);
  expect(mail?.unit.people).toEqual([]);
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

test("lifelog chapters become units with lifelog's summary, turn refs and resolved people", () => {
  const units = lifelogUnits([conversation], nameIndex(people)).map(
    (b) => b.unit
  );
  expect(units).toHaveLength(2);
  expect(units[0]?.refs).toEqual([
    "00000000-0000-8000-8000-01a1210b4bdf#chapter-1",
    "job-1:0@2026-10-09T10:00:00.000Z",
  ]);
  expect(units[0]?.id).toBe(unitId("lifelog", "chapter-1"));
  expect(units[0]?.stats.items).toBe(10);
  expect(units[0]?.people).toEqual(["person:me", "unknown:Gaston"]);
  expect(units[0]?.end).toBe("2026-10-09T10:20:00.000Z");
  expect(units[1]?.end).toBe(conversation.endedAt);
  expect(units[0]?.summary).toBe("Jean and Gaston list the shop repairs.");
  const unsummarized = lifelogUnits(
    [{ ...conversation, chapters: [], state: "transcribed" }],
    nameIndex(people)
  );
  expect(applyRules(unsummarized)[0]?.unit.drop).toBe("no-summary");
});

test("names: aliases resolve, parentheses are ignored, a shared name resolves to nobody", () => {
  const index = nameIndex([
    ...people,
    { ...people[1], aliases: [], id: "other", name: "Pops" } as Person,
  ]);
  expect(personRef("Jean (Me)", index)).toBe("person:me");
  expect(personRef("Jean Senior", index)).toBe("person:dad");
  expect(personRef("Pops", index)).toBe("unknown:Pops");
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
            sender: "alerts@send.make-a-dent.com",
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
          LIFE_MAIL.from,
          "Bakery · 18 oct. — the shop slips again",
          "Two forward bookings are inactive."
        ),
        mail(
          "m6",
          LIFE_MAIL.from,
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
  expect(dayRange()).toEqual({ from: undefined, to: undefined });
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
    lifelogUnits(
      readConversations(store, dayStart("2026-10-15")),
      new Map()
    ).map((b) => [b.unit.date, b.unit.start])
  ).toEqual([
    ["2026-10-14", "2026-10-14T21:40:00.000Z"],
    ["2026-10-15", "2026-10-14T22:10:00.000Z"],
  ]);
});
