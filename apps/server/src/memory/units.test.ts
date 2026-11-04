import { expect, test } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAY, HOUR, MIN } from "../core/clock";
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
  type LifelogConversation,
  openStore,
  readConversations,
  readPhoneZone,
  WATCH,
} from "../sources/lifelog";
import { copyNotes, readNotes } from "../sources/notes";
import {
  claudeExport,
  conversation as feedConversation,
  lifelogServer,
  lifelogStore,
  noteData,
  notesFixture,
  pageFixture,
  runFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { LIFE_MAIL } from "./email";
import { IMPORTED, keptConversations, readUnits, UNITS, ZONES } from "./ledger";
import { showFiles } from "./message-files";
import { loadTruth } from "./read-truth";
import { SOURCES } from "./sources";
import {
  applyRules,
  dayRange,
  daysBefore,
  gather,
  isFrozen,
  lastDays,
  lifeChat,
  lifelogUnits,
  MARKED,
  messageUnits,
  normalizeTopics,
  oneToOne,
  speakerOf,
  syncLifelogUnits,
  unitId,
  writeUnits,
} from "./units";
import { resolver, unitNow } from "./who";
import { chatLines } from "./words";
import {
  cutAt,
  dayStart,
  firstZoneDay,
  localDate,
  noteZone,
  readZoneHere,
  zoneAt,
} from "./zones";

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

const UNIT_ID = /^unit_[0-9a-f]{12}$/;

const msg = (over: Partial<SourceEvent>): SourceEvent => ({
  at: "2026-10-09T10:00:00.000Z",
  chat: "!chat:matrix",
  chatName: "Dad",
  fromMe: false,
  id: "line:!chat/1",
  sender: "+33600000002",
  source: "line",
  text: "Can you call the plumber today?",
  ...over,
});

/** A turn of the conversation below: `n` minutes after 10:00 on 25 Oct (UTC), by `name` or by him. */
const said = (n: number, name: string | null, owner = false) => ({
  at: new Date(Date.parse("2026-10-25T10:00:00.000Z") + n * MIN).toISOString(),
  end: null,
  jobId: "job-1",
  marks: [] as string[],
  name,
  owner,
  personId: null,
  seen: null,
  turnIndex: n,
});

const conversation: LifelogConversation = {
  closed: false,
  endedAt: "2026-10-25T10:40:00.000Z",
  id: "00000000-0000-8000-8000-01a1210b4bdf",
  startedAt: "2026-10-25T10:00:00.000Z",
  title: "",
  turns: [said(0, null, true), said(5, "Gaston"), said(30, "Jean (Me)")],
};

/** No stored chapter unit: every conversation becomes conversation-days. */
const none = new Set<string>();

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
      msg({ id: "line:!chat/1" }),
      msg({
        at: "2026-10-09T11:00:00.000Z",
        fromMe: true,
        id: "line:!chat/2",
        sender: "me",
        text: "Yes, at 5",
      }),
      msg({
        at: "2026-10-12T11:00:00.000Z",
        id: "line:!chat/3",
        text: "Thanks",
      }),
    ],
    handles
  );
  expect(built).toHaveLength(2);
  const day = built[0]?.unit;
  expect(day?.refs).toEqual(["line:!chat/1", "line:!chat/2"]);
  expect(day?.people).toEqual(["person:me", "unknown:+33600000002"]);
  expect(day?.stats).toEqual({ chars: 40, fromMe: 1, items: 2 });
  expect(day?.summary).toBeUndefined();
  expect(built[0]?.text).toContain("dad: Can you call the plumber today?");
});

test("a unit keeps its senders unresolved whoever they resolve to now (a reader maps them), a note's none, and its hash never moves", () => {
  const [unknown] = messageUnits([msg({})], () => null);
  const [known] = messageUnits([msg({})], () => "person:inf_plumber");
  const [mail] = messageUnits([msg({ source: "mail" })], () => null);
  const [note] = messageUnits([msg({ source: "notes" })], () => null);
  expect(known?.unit.people).toEqual(["unknown:+33600000002"]);
  expect(known?.text).toContain("inf_plumber: ");
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

test("a conversation's day is one unit, built from its turns alone: first and last turn refs, him and its names unresolved", () => {
  const [b] = lifelogUnits([conversation], none);
  const unit = b?.unit;
  expect(unit?.id).toBe(unitId("lifelog", conversation.id, "2026-10-25"));
  expect(unit?.refs).toEqual([
    "job-1:0@2026-10-25T10:00:00.000Z",
    "job-1:30@2026-10-25T10:30:00.000Z",
  ]);
  expect(unit?.people).toEqual([
    "person:me",
    "unknown:Gaston",
    "unknown:Jean (Me)",
  ]);
  expect(unit?.stats).toEqual({ chars: 0, fromMe: 1, items: 3 });
  expect([unit?.start, unit?.end]).toEqual([
    "2026-10-25T10:00:00.000Z",
    conversation.endedAt,
  ]);
  expect(unit?.title).toBe("Recorded conversation");
  expect(unit?.summary).toBeUndefined();
  // Life holds no words: its text is filled when its day is read (voiceText).
  expect(b?.text).toBe("");
  expect(
    lifelogUnits([{ ...conversation, title: "Plumber" }], none)[0]?.unit.title
  ).toBe("Plumber");
});

test("a voice given to someone else changes its unit's hash, so its day is read again (29 Oct 2026: 96 voices named, their days kept the old names)", () => {
  const hashOf = (turns: LifelogConversation["turns"]) =>
    lifelogUnits([{ ...conversation, turns }], none)[0]?.unit.hash;
  const before = hashOf(conversation.turns);
  const [mine, gaston, jean] = conversation.turns as [
    LifelogConversation["turns"][number],
    LifelogConversation["turns"][number],
    LifelogConversation["turns"][number],
  ];
  expect(hashOf([mine, { ...gaston, personId: "p-1" }, jean])).not.toBe(before);
  expect(hashOf([mine, { ...gaston, name: "Rose" }, jean])).not.toBe(before);
  expect(hashOf([{ ...mine, owner: false }, gaston, jean])).not.toBe(before);
  // The same person under a new name (his truth's) is the same voice.
  const named = [mine, { ...gaston, personId: "p-1" }, jean];
  expect(
    hashOf([mine, { ...gaston, name: "Gus", personId: "p-1" }, jean])
  ).toBe(hashOf(named));
});

test("a conversation across midnight is two units; a conversation with a stored chapter unit is none", () => {
  // Lagos, UTC+1: 23:50 on the 25th is 22:50Z, 00:10 on the 26th is 23:10Z.
  const late = {
    ...conversation,
    endedAt: "2026-10-25T23:30:00.000Z",
    turns: [said(12 * 60 + 50, null, true), said(13 * 60 + 10, "Gaston")],
  };
  expect(
    lifelogUnits([late], none).map((b) => [b.unit.date, b.unit.end])
  ).toEqual([
    ["2026-10-25", "2026-10-25T23:00:00.000Z"],
    ["2026-10-26", "2026-10-25T23:30:00.000Z"],
  ]);
  expect(lifelogUnits([late], new Set([late.id]))).toEqual([]);
  // A chapter unit carries lifelog's summary; a placeholder (never summarized) and a repo-day's summary don't freeze.
  expect(isFrozen({ source: "lifelog", summary: "A summary." })).toBe(true);
  expect(isFrozen({ source: "lifelog", summary: "" })).toBe(false);
  expect(isFrozen({ source: "lifelog" })).toBe(false);
  expect(isFrozen({ source: "git", summary: "Change 1" })).toBe(false);
});

test("a turn of one of his asks moves its unit's hash and its refs are kept; a turn added moves it too, a name given does not", () => {
  const [plain] = lifelogUnits([conversation], none);
  const [marked] = lifelogUnits(
    [
      {
        ...conversation,
        turns: [
          { ...said(0, null, true), marks: ["job-1:0@x", "job-1:1@x"] },
          ...conversation.turns.slice(1),
        ],
      },
    ],
    none
  );
  expect(marked?.unit.marked).toEqual(["job-1:0@x", "job-1:1@x"]);
  expect(marked?.unit.hash).not.toBe(plain?.unit.hash);
  const [grown] = lifelogUnits(
    [{ ...conversation, turns: [...conversation.turns, said(35, null)] }],
    none
  );
  expect(grown?.unit.hash).not.toBe(plain?.unit.hash);
  const [named] = lifelogUnits(
    [
      {
        ...conversation,
        turns: conversation.turns.map((t) => ({
          ...t,
          name: t.name ?? "Anne",
        })),
      },
    ],
    none
  );
  expect(named?.unit.hash).toBe(plain?.unit.hash);
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
    ...messageUnits([msg({ chat: lifeChat(), id: "b:4" })], () => null),
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

test("mail reaches memory only from someone Jean knows, in a thread he wrote in, or as a transaction; login codes and Life's own mail never; his agents' reports always", () => {
  const mail = (
    id: string,
    sender: string,
    title: string,
    text: string,
    over: Partial<SourceEvent> = {}
  ) =>
    msg({
      chat: id,
      chatName: title,
      id,
      sender,
      source: "mail",
      text: `${title}\n${text}`,
      ...over,
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
        mail("m7", "paul@example.test", "Boat", "The boat is ready.", {
          contact: true,
        }),
        mail("m8", "sales@shop.test", "Your quote", "Here is the quote."),
        mail("m8", "jean@mine.test", "Re: Your quote", "Deal.", {
          fromMe: true,
        }),
        mail("m9", "stranger@example.test", "Hello", "Want to buy my boat?"),
        mail("m10", "booking@airline.test", "Your flight", "Seat 12A.", {
          transaction: true,
        }),
        mail("m11", "ci@forge.test", "Build passed", "All green.", {
          bulk: true,
          transaction: true,
        }),
      ],
      (s) => (s === "marie@example.test" ? "person:marie" : null)
    )
  );
  expect(built.map((b) => b.unit.drop ?? null)).toEqual([
    "one-time-code",
    "not-a-person",
    "not-a-person",
    null,
    "life-output",
    null,
    null,
    null,
    "not-a-person",
    null,
    "newsletter",
  ]);
});

test("a 1:1 chat's title names its unknown member; a group or a mail thread names nobody", () => {
  const handles = () => null;
  const [one] = messageUnits(
    [msg({ chatName: "Anne-Sophie", sender: "@line_x:matrix.local" })],
    handles
  );
  expect(one && oneToOne(one)).toBe("Anne-Sophie");
  const [group] = messageUnits(
    [
      msg({ chatName: "Builders", sender: "+66000000001" }),
      msg({
        chatName: "Builders",
        id: "line:!chat/2",
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
    DAY
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
    now + MIN
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
  const [b] = messageUnits(
    [
      commit(1, {}),
      commit(2, { fromMe: false, sender: "Jérôme" }),
      commit(3, { fromMe: false, sender: "Jérôme" }),
    ],
    () => null
  );
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

test("where he is now: the phone's latest zone, whatever its age; the Mac's only when no phone said one; lifelog unreadable, no change", async () => {
  const mac = () => "Europe/Berlin";
  const phone = (tz: string | null) => () => Promise.resolve(tz);
  // The Life server may run anywhere: the phone says where he is.
  expect(await readZoneHere({ mac, phone: phone("Asia/Jakarta") })).toBe(
    "Asia/Jakarta"
  );
  // No phone ever named a zone (lifelog not set up, or no heartbeat with one): the Mac's.
  expect(await readZoneHere({ mac, phone: phone(null) })).toBe("Europe/Berlin");
  // lifelog set up but unreadable: nothing to record, so the last zone (the phone's) stands; never the server's.
  expect(
    await readZoneHere({
      mac,
      phone: () => Promise.reject(new Error("lifelog down")),
    })
  ).toBeUndefined();
  // The same through lifelog's real status read: a failed request (no route, 404) and an answer it can't read.
  const failing: Record<string, () => unknown>[] = [
    {},
    { "/status": () => ({ phoneHeartbeat: "not a heartbeat" }) },
  ];
  for (const routes of failing) {
    const server = lifelogServer(routes);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: one fake lifelog at a time, each sets the settings it is read by
      expect(await readZoneHere({ mac, phone: readPhoneZone })).toBeUndefined();
    } finally {
      server.close();
    }
  }
});

test("a zone noticed is recorded once, from when `cutAt` says; none or the same, nothing", async () => {
  const was = readFileSync(ZONES, "utf8");
  // The fixture's latest move: Lagos from 19 Oct.
  const noon = new Date("2026-11-02T10:00:00.000Z");
  try {
    await noteZone(undefined, noon);
    await noteZone("Africa/Lagos", noon);
    expect(readFileSync(ZONES, "utf8")).toBe(was);
    await noteZone("Asia/Jakarta", noon);
    await noteZone("Asia/Jakarta", noon);
    expect(readFileSync(ZONES, "utf8").slice(was.length)).toBe(
      `${JSON.stringify({ from: cutAt(noon, "Africa/Lagos", "Asia/Jakarta").toISOString(), schemaVersion: 1, tz: "Asia/Jakarta" })}\n`
    );
  } finally {
    writeFileSync(ZONES, was);
  }
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
          id: unitId("whatsapp", "!chat:matrix", date ?? ""),
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

/** The sources of the units in memory/units/, by day. */
const sourcesByDay = async () =>
  Object.fromEntries(
    Map.groupBy(await readUnits(), (u) => u.date)
      .entries()
      .map(([d, us]) => [d, us.map((u) => u.source)])
  );

test("a conversation that moves to another day leaves its old day's file; other sources' units in that file stay", async () => {
  expect(existsSync(UNITS)).toBe(false); // test data has no units: this test makes and removes them
  const chat: Unit = {
    date: "2026-10-25",
    end: "2026-10-25T09:00:00.000Z",
    hash: "0123456789abcdef",
    id: "unit_00000000000a",
    key: "120@g.us",
    people: [],
    refs: ["whatsapp:120@g.us/1"],
    schemaVersion: 1,
    source: "whatsapp",
    start: "2026-10-25T09:00:00.000Z",
    stats: { chars: 40, fromMe: 1, items: 1 },
    title: "Team",
  };
  const store = lifelogStore();
  const on = (day: string) =>
    pageFixture({
      conversations: [
        feedConversation("c1", {
          endAt: `${day}T10:10:00.000Z`,
          startAt: `${day}T10:00:00.000Z`,
        }),
      ],
      turns: [turnFixture(0, `${day}T10:00:00.000Z`, null, null)],
    });
  try {
    await writeUnits([chat.date], [chat]);
    apply(store, on("2026-10-25"));
    await syncLifelogUnits(store);
    expect(await sourcesByDay()).toEqual({
      "2026-10-25": ["whatsapp", "lifelog"],
    });
    // Regrouped onto the next day: a new id, the old one leaves (unit ids are by conversation and day).
    apply(store, on("2026-10-26"));
    expect(await syncLifelogUnits(store)).toMatchObject({
      added: 1,
      removed: 1,
    });
    expect(await sourcesByDay()).toEqual({
      "2026-10-25": ["whatsapp"],
      "2026-10-26": ["lifelog"],
    });
    // A night that could not read WhatsApp (its access gone) rewrites the day without losing its units.
    const mail = { ...chat, id: "unit_00000000000b", source: "mail" as const };
    await writeUnits([chat.date], [mail], (u) => u.source === "whatsapp");
    expect(await sourcesByDay()).toMatchObject({
      "2026-10-25": ["whatsapp", "mail"],
    });
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
  }
});

/** A stored lifelog unit of conversation `key` on 20 Oct: a chapter when it has a summary. */
const storedVoice = (id: string, key: string, summary?: string): Unit => ({
  date: "2026-10-20",
  end: "2026-10-20T10:20:00.000Z",
  hash: "0123456789abcdef",
  id,
  key,
  people: [],
  refs: [`${key}#ch`],
  schemaVersion: 1,
  source: "lifelog",
  start: "2026-10-20T10:00:00.000Z",
  stats: { chars: 9, fromMe: 0, items: 2 },
  ...(summary ? { summary } : {}),
  title: "Shop",
});

test("a stored chapter unit stays as stored while its conversation is live, and gets it no conversation-day; a placeholder is replaced; another conversation becomes conversation-days; a retired one takes its chapter with it", async () => {
  expect(existsSync(UNITS)).toBe(false);
  const chapter = storedVoice("unit_00000000000c", "c1", "A summary.");
  const placeholder = storedVoice("unit_00000000000e", "c2");
  const store = lifelogStore();
  const at = "2026-10-20T10:00:00.000Z";
  apply(
    store,
    pageFixture({
      conversations: [feedConversation("c1"), feedConversation("c2")],
      turns: [
        turnFixture(0, at, null, null, "c1"),
        turnFixture(1, at, null, null, "c2"),
      ],
    })
  );
  try {
    await writeUnits([chapter.date], [chapter, placeholder]);
    expect(await syncLifelogUnits(store)).toMatchObject({
      added: 1,
      removed: 1,
    });
    expect((await readUnits()).map((u) => [u.id, u.key])).toEqual([
      [chapter.id, "c1"],
      [unitId("lifelog", "c2", "2026-10-20"), "c2"],
    ]);
    expect((await readUnits())[0]).toEqual(chapter);
    // lifelog retires c1 into c3: c1's chapter goes with it, c3's days come.
    apply(
      store,
      pageFixture({
        conversations: [
          feedConversation("c1", { retired: { successorId: "c3" } }),
          feedConversation("c3"),
        ],
        turns: [turnFixture(0, at, null, null, "c3")],
      })
    );
    expect(await syncLifelogUnits(store)).toMatchObject({
      added: 1,
      removed: 1,
    });
    expect((await readUnits()).map((u) => u.id)).toEqual([
      unitId("lifelog", "c2", "2026-10-20"),
      unitId("lifelog", "c3", "2026-10-20"),
    ]);
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
  }
});

test("a conversation from 23:40 to 00:30 at the window start is read whole: its 00:10 turn is on the window's first day", () => {
  // Lagos, UTC+1: 23:40 on the 25th is 22:40Z, the window starts at 00:00 on the 26th (23:00Z).
  const store = lifelogStore();
  apply(
    store,
    pageFixture({
      conversations: [
        feedConversation("c1", {
          endAt: "2026-10-25T23:30:00.000Z",
          startAt: "2026-10-25T22:40:00.000Z",
        }),
      ],
      turns: [
        turnFixture(0, "2026-10-25T22:40:00.000Z", null, null),
        turnFixture(1, "2026-10-25T23:10:00.000Z", null, null),
      ],
    })
  );
  expect(
    lifelogUnits(readConversations(store, dayStart("2026-10-26")), none).map(
      (b) => [b.unit.date, b.unit.start]
    )
  ).toEqual([
    ["2026-10-25", "2026-10-25T22:40:00.000Z"],
    ["2026-10-26", "2026-10-25T23:10:00.000Z"],
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

test("a sweep reads a stored chapter unit as stored, a marked one still saying so", async () => {
  const before = readSettings().sources;
  const marked = {
    ...storedVoice("unit_00000000000d", "conv-1", "A summary."),
    marked: ["job-1:0@x"],
  };
  // lifelog set up, its store holding conv-1 live (no words: no conversation-day either way).
  const server = lifelogServer({});
  const store = openStore();
  apply(store, pageFixture({ conversations: [feedConversation("conv-1")] }));
  store.db.close();
  try {
    setSettings({ sources: ["lifelog"] });
    await writeUnits([marked.date], [marked]);
    const e = await gather(
      { from: "2026-10-20", to: "2026-10-21" },
      { resolve: () => null, truth: await loadTruth() }
    );
    expect(e.built.map((b) => [b.unit.id, b.text])).toEqual([
      [marked.id, `Shop\nA summary.\n${MARKED}`],
    ]);
  } finally {
    server.close();
    setSettings({ sources: before });
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(WATCH, { force: true, recursive: true });
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
      runFixture(text.length + 1),
      runFixture(1, { attachment: "A1" }),
      runFixture(1, { attachment: "T1" }),
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
  for (const pk of [1, 2, 3]) {
    save(pk, noteData(`Note text ${pk}`), { agoS: 5 * 86_400 });
  }
  copyNotes(source, dir, now - 3 * DAY);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK = 1");
  copyNotes(source, dir, now - 2 * DAY);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK = 2");
  copyNotes(source, dir, now - DAY);
  save(1, noteData("Note text 1\nback"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now);
  const built = applyRules(
    messageUnits(
      showFiles(readNotes(new Date(now - 2.5 * DAY), dir), new Map()),
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
  for (const pk of [1, 2, 3]) {
    save(pk, noteData(`Note text ${pk}`), { agoS: 5 * 86_400 });
  }
  copyNotes(source, dir, now - 4 * DAY);
  db.run("delete from ZICCLOUDSYNCINGOBJECT where Z_PK in (1, 2)");
  copyNotes(source, dir, now - 3 * DAY);
  save(1, noteData("Note text 1"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now - 2 * DAY);
  save(2, noteData("Note text 2"), { agoS: 5 * 86_400 });
  copyNotes(source, dir, now - DAY);
  const built = applyRules(
    messageUnits(
      showFiles(readNotes(new Date(now - 2.5 * DAY), dir), new Map()),
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
  const [unit] = messageUnits(readNotes(new Date(now - HOUR), dir), () => null);
  expect(unit && chatLines(unit, () => null).map((l) => l.speaker)).toEqual([
    "unknown:shared note",
  ]);
  expect(unit?.unit.stats.fromMe).toBe(0);
});
