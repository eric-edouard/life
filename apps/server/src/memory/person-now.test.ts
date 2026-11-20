import { Database } from "bun:sqlite";
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeJson } from "../core/files";
import { OWNER_DATA_DIR } from "../core/paths";
import { promptNameOf } from "../models/prompt-parts";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import { apply } from "../sources/lifelog";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as voices from "../sources/lifelog-voices";
import {
  conversation,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import {
  buildIndex,
  readStaleness,
  reindex,
  reindexUnits,
} from "./index-writer";
import {
  EPISODES,
  INDEX,
  INFERRED,
  situationPath,
  UNITS,
} from "./memory-files";
import { openById } from "./open-by-id";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as kept from "./party";
import {
  firstSentenceOf,
  knowsOf,
  type MatterRowNow,
  type PersonRow,
  peopleListOf,
  personNowOf,
  reachPageOf,
  readHeardAudio,
  rowOf,
} from "./person-now";
import { readPersonUnits } from "./person-units";
import { type Reach, reachOf } from "./reach";
import { PART_CHARS } from "./read-part";
import { person } from "./read-person-page";
import { OWNER } from "./read-truth";
import { madeBy, unit as unitFixture } from "./record-fixtures";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as sources from "./sources";

// Made-up people, organizations and chats only (test-data/truth: Test Owner, Test Ana, Test Bakery).

afterEach(() => {
  rmSync(INDEX, { force: true });
  rmSync(UNITS, { force: true, recursive: true });
  rmSync(INFERRED, { force: true });
});

const party = (ref: string, name: string) => ({
  kind: "person" as const,
  name,
  ref,
});
const row = (ref: string, level?: PersonRow["level"], at?: string) => ({
  ...party(ref, ref.slice(7)),
  ...(at ? { lastExchangeAt: at } : {}),
  ...(level ? { level } : {}),
  needsYou: false,
});
const matter = (n: number, over: Partial<MatterRowNow> = {}): MatterRowNow => ({
  blockingChecks: 0,
  id: `matter_${String(n).padStart(12, "0")}`,
  name: `Matter ${n}: ${"an errand with a long name ".repeat(4)}`,
  needsYou: false,
  people: { with: [party("person:ana", "Ana")] },
  status: "moving",
  ...over,
});

test("the list: by level, inner first, the unjudged after all four; inside a level the newest exchange first", () => {
  const list = peopleListOf([
    row("person:zed"),
    row("person:old", "faded", "2026-11-19T10:00:00.000Z"),
    row("person:bo", "regular", "2026-10-01T10:00:00.000Z"),
    row("person:cy", "regular", "2026-11-01T10:00:00.000Z"),
    row("person:ana", "inner"),
    row("person:dee", "acquaintance"),
  ]);
  expect(list.map((r) => r.ref.slice(7))).toEqual([
    "ana",
    "cy",
    "bo",
    "dee",
    "old",
    "zed",
  ]);
});

test("a row: the closer of its two levels, its last exchange, and needsYou from any of its running matters", () => {
  const standing = {
    lastExchangeAt: () => "2026-11-18T10:00:00.000Z",
    levelOf: () => ({ personal: "faded" as const, work: "regular" as const }),
  };
  const ana = party("person:ana", "Ana");
  expect(rowOf(ana, standing, [matter(1)])).toEqual({
    ...ana,
    lastExchangeAt: "2026-11-18T10:00:00.000Z",
    level: "regular",
    needsYou: false,
  });
  expect(
    rowOf(ana, standing, [matter(1), matter(2, { needsYou: true })]).needsYou
  ).toBe(true);
  // A matter that needs him but is someone else's is not hers.
  expect(
    rowOf(ana, { lastExchangeAt: () => undefined, levelOf: () => undefined }, [
      matter(3, {
        needsYou: true,
        people: { owedTo: [party("person:bo", "Bo")] },
      }),
    ])
  ).toEqual({ ...ana, needsYou: false });
});

test("`now` holds under PART_CHARS with hundreds of open matters, the top-ranked first, and counts the rest", () => {
  const matters = Array.from({ length: 300 }, (_, i) => matter(i));
  const now = personNowOf({
    communicationStyle: [],
    details: [
      { from: "truth", kind: "birthday", text: "--03-12" },
      { from: "truth", kind: "handles", text: "+33600000001" },
      { from: "contacts", kind: "handles", text: "Facebook: ana.t" },
    ],
    episodes: [{ month: "2026-11", titles: ["A walk"] }],
    knows: [],
    matters,
    pictures: [],
    reach: [
      {
        accounts: [
          {
            handle: "+33 6 00 00 00 01",
            open: { lands: "chat", url: "https://wa.me/33600000001" },
          },
        ],
        label: "WhatsApp",
        network: "whatsapp",
      },
    ],
    row: row("person:me"),
    situation: [{ cites: ["ep_000000000001"], text: "Busy with the move." }],
    today: "2026-03-10",
  });
  expect(JSON.stringify(now).length).toBeLessThanOrEqual(PART_CHARS);
  expect(now.open[0]?.id).toBe(matters[0]?.id);
  expect(now.open.length + (now.more?.open ?? 0)).toBe(300);
  expect(now.more?.open).toBeGreaterThan(0);
  // A birthday dated; a handle the reach already opens is not a detail again.
  expect(now.details).toEqual([
    {
      from: "truth",
      kind: "birthday",
      next: { age: null, day: "2026-03-12", left: 2 },
      text: "--03-12",
    },
    { from: "contacts", kind: "handles", text: "Facebook: ana.t" },
  ]);
  const few = personNowOf({ ...now, ...inputsOf(now), matters: [matter(1)] });
  expect(few.more).toBeUndefined();
  // A large list other than the matters (60 long episode titles), with a shared name's wrapper: the whole answer stays within its room, the oldest months cut and counted.
  const episodes = Array.from({ length: 60 }, (_, n) => ({
    month: `2021-${String(12 - (n % 12)).padStart(2, "0")}`,
    titles: [`${"A long afternoon at the market together ".repeat(3)}${n}`],
  }));
  const wrapper = { candidates: [party("person:ana", "Ana")] };
  const room = PART_CHARS - JSON.stringify({ ...wrapper, now: {} }).length;
  const busy = personNowOf(
    { ...now, ...inputsOf(now), episodes, matters: [] },
    room
  );
  expect(JSON.stringify({ ...wrapper, now: busy }).length).toBeLessThanOrEqual(
    PART_CHARS
  );
  expect(busy.episodes[0]).toEqual(episodes[0]);
  expect(busy.episodes.length + (busy.more?.episodes ?? 0)).toBe(60);
  expect(busy.more?.episodes).toBeGreaterThan(0);
  // An organization with 250 domains: cut and counted too.
  const domains = Array.from(
    { length: 250 },
    (_, n) => `shop-number-${n}.example.test`
  );
  const org = personNowOf({
    ...now,
    ...inputsOf(now),
    matters: [],
    organization: { domains, people: [] },
  });
  expect(JSON.stringify(org).length).toBeLessThanOrEqual(PART_CHARS);
  expect((org.domains?.length ?? 0) + (org.more?.domains ?? 0)).toBe(250);
});

/** `now`'s inputs back from a `now` (a second read of the same person). */
const inputsOf = (now: ReturnType<typeof personNowOf>) => ({
  communicationStyle: now.communicationStyle,
  details: [],
  episodes: now.episodes,
  knows: now.knows,
  pictures: [],
  reach: now.reach,
  row: row(now.ref),
  situation: now.situation,
  today: "2026-03-10",
});

test("knows: each part that holds something, with its ref and first sentence; an empty part is left out", () => {
  expect(
    firstSentenceOf([
      "(page built 2026-11-18 03:00 UTC: newer observations are in the evidence, not on it yet)",
      "# Ana\n\n## Now\n- Ana runs the bakery. She opens at six.",
    ])
  ).toBe("Ana runs the bakery.");
  expect(firstSentenceOf(["Evidence:", "Observations:", "(none)"])).toBe(
    undefined
  );
  const read = (part: "page" | "persona") => ({
    ref: { part, subject: "person:ana" },
  });
  expect(
    knowsOf([read("page"), read("persona")], (p) =>
      p === "page" ? ["Who she is, in short. More."] : ["(no persona yet)"]
    )
  ).toEqual([
    { first: "Who she is, in short.", part: "page", ref: "person:ana/page" },
  ]);
});

/** `units` stored and indexed as the watcher indexes them (`reindexUnits`: who each is with as of today). */
const indexed = async (units: Unit[]) => {
  mkdirSync(dirname(INDEX), { recursive: true });
  mkdirSync(UNITS, { recursive: true });
  for (const [day, list] of Map.groupBy(units, (u) => u.date)) {
    writeFileSync(
      join(UNITS, `${day}.jsonl`),
      list.map((u) => `${JSON.stringify(u)}\n`).join("")
    );
  }
  buildIndex([], INDEX, {
    corrections: [],
    live: new Set(),
    retired: new Map(),
    standing: new Map(),
  });
  await reindexUnits(units);
};

test("the read with no name: his directory's people and organizations, him left out; a query's matches and its others", async () => {
  await indexed([]);
  writeFileSync(
    INFERRED,
    `${JSON.stringify({
      area: null,
      at: "2026-11-12T03:00:00.000Z",
      confidence: 0.9,
      evidence: [{ quote: "hello there", unit: "unit_1" }],
      id: "inf_test-anna",
      madeBy: { engine: "codex", model: "m", prompt: "p", run: "r" },
      name: "Test Anna",
      namesAndHandles: ["Test Anna"],
      person: null,
      project: null,
      relation: "a neighbour",
      schemaVersion: 1,
    })}\n`
  );
  const all = (await person()) as { people: PersonRow[] };
  const refs = all.people.map((r) => r.ref);
  expect(refs).toContain("person:test-ana");
  expect(refs).toContain("person:test-bakery");
  expect(refs).not.toContain("person:me");
  expect(all.people.find((r) => r.ref === "person:test-bakery")).toMatchObject({
    kind: "organization",
    needsYou: false,
  });
  const found = (await person(undefined, { query: "test ana" })) as {
    others: { ref: string }[];
    people: PersonRow[];
  };
  expect(found.people.map((r) => r.ref)).toEqual(["person:test-ana"]);
  expect(found.others.map((p) => p.ref)).toEqual(["person:inf_test-anna"]);
  expect(
    (
      (await person(undefined, { query: "the bakery" })) as {
        people: PersonRow[];
      }
    ).people.map((r) => r.ref)
  ).toEqual(["person:test-bakery"]);
});

test("`now` of a person and of an organization: their row, reach and open matters; an organization's people and domains", async () => {
  await indexed([]);
  const theirs = matter(1, {
    needsYou: true,
    people: { with: [party("person:test-ana", "Test Ana")] },
  });
  const ana = (await person("Test Ana", {}, {}, () =>
    Promise.resolve([theirs, matter(2)])
  )) as Record<string, unknown>;
  expect(ana).toMatchObject({
    kind: "person",
    name: "Test Ana",
    needsYou: true,
    open: [{ id: theirs.id }],
    ref: "person:test-ana",
  });
  expect(ana.line).toBe("baker, Test Bakery");
  const bakery = (await person("Test Bakery")) as Record<string, unknown>;
  expect(bakery).toMatchObject({
    domains: ["bakery.example"],
    kind: "organization",
    people: [{ party: { ref: "person:test-ana" }, role: "baker" }],
    reach: [
      {
        accounts: [{ handle: "hello@bakery.example" }],
        network: "mail",
      },
    ],
  });
});

test("`now` lists every picture kept of them, one per source; the one in use is their `picture`", async () => {
  await indexed([]);
  const shown = [
    { id: "pic-contacts", source: "contacts" },
    { id: "pic-whatsapp", source: "whatsapp" },
  ];
  const spy = spyOn(kept, "readPictureIndex").mockReturnValue({
    "person:test-ana": shown,
  });
  try {
    expect(await person("Test Ana")).toMatchObject({
      picture: { id: "pic-contacts" },
      pictures: shown,
    });
  } finally {
    spy.mockRestore();
  }
});

test("the edge cases of `now`: a name no one goes by says so with the parties near it", async () => {
  await indexed([]);
  expect(await person("Test Anx")).toEqual({
    near: [expect.objectContaining({ ref: "person:test-ana" })],
    noOne: "Test Anx",
  });
});

test("latest: their newest 1:1 exchanges, five a page by whole days, through one index read a round; before pages back", async () => {
  const chat = "33600000001@s.whatsapp.net";
  const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
  const units = Array.from({ length: 8 }, (_, i) =>
    unitFixture({
      date: day(i + 1),
      end: `${day(i + 1)}T10:05:00.000Z`,
      id: `unit_${String(i + 1).padStart(12, "0")}`,
      key: chat,
      people: ["person:test-ana", "person:me"],
      source: "whatsapp",
      start: `${day(i + 1)}T10:00:00.000Z`,
      title: "Ana B",
    })
  );
  const said = (d: string, fromMe: boolean, text: string): SourceEvent => ({
    at: `${d}T10:0${fromMe ? 1 : 0}:00.000Z`,
    chat,
    chatName: "Ana B",
    fromMe,
    id: `whatsapp:${chat}/${d}${fromMe}`,
    sender: fromMe ? "me" : "Test Ana",
    source: "whatsapp",
    text,
  });
  const real = sources.sourceOf;
  const spy = spyOn(sources, "sourceOf").mockImplementation(
    (name) =>
      ({
        ...real(name),
        read: (since: Date) => {
          const d = since.toISOString().slice(0, 10);
          return [said(d, false, `Hello on ${d}`), said(d, true, "Hi")];
        },
      }) as never
  );
  try {
    await indexed(units);
    const first = (await person("Test Ana", { part: "latest" })) as {
      latest: {
        at: string;
        channel: string;
        lines: unknown[];
        open?: unknown;
      }[];
      nextBefore?: string;
    };
    expect(first.latest.map((x) => x.at.slice(0, 10))).toEqual([
      day(8),
      day(7),
      day(6),
      day(5),
      day(4),
    ]);
    expect(first.latest[0]).toEqual({
      at: `${day(8)}T10:00:00.000Z`,
      channel: "whatsapp",
      lines: [
        { by: "them", text: `Hello on ${day(8)}` },
        { by: "him", text: "Hi" },
      ],
      open: { lands: "chat", url: "https://wa.me/33600000001" },
    });
    expect(first.nextBefore).toBe(day(4));
    const second = (await person("Test Ana", {
      before: first.nextBefore,
      part: "latest",
    })) as typeof first;
    expect(second.latest.map((x) => x.at.slice(0, 10))).toEqual([
      day(3),
      day(2),
      day(1),
    ]);
    expect(second.nextBefore).toBeUndefined();
  } finally {
    spy.mockRestore();
  }
});

test("latest: a mail thread someone else wrote in too is not theirs, though the index files it under them alone", async () => {
  const at = (m: number) => `2026-11-10T10:0${m}:00.000Z`;
  const mail = (m: number, sender: string, text: string): SourceEvent => ({
    at: at(m),
    chat: "thread-quote",
    chatName: "The quote",
    fromMe: sender === "me",
    id: `mail:thread-quote/${m}`,
    sender,
    source: "mail",
    text,
  });
  const events = [
    mail(0, "Test Ana", "Here is the quote"),
    mail(1, "sales@shop.example.test", "Our own quote"),
    mail(2, "me", "Thanks"),
  ];
  const real = sources.sourceOf;
  const spy = spyOn(sources, "sourceOf").mockImplementation(
    (name) => ({ ...real(name), read: () => events }) as never
  );
  try {
    await indexed([
      unitFixture({
        date: "2026-11-10",
        end: at(2),
        id: "unit_0000000000a1",
        key: "thread-quote",
        people: [
          "person:me",
          "unknown:Test Ana",
          "unknown:sales@shop.example.test",
        ],
        source: "mail",
        start: at(0),
        title: "The quote",
      }),
    ]);
    // The index leaves out the sender no one knows: the thread reads as hers alone.
    expect(
      readPersonUnits(["person:test-ana"], { count: 5, kinds: ["mail"] }).map(
        (u) => u.people.toSorted()
      )
    ).toEqual([["person:me", "person:test-ana"]]);
    const read = (await person("Test Ana", { part: "latest" })) as {
      latest: unknown[];
    };
    expect(read.latest).toEqual([]);
  } finally {
    spy.mockRestore();
  }
});

test("the edge cases of `now`: a name two go by gives them as candidates, and the first's `now`", async () => {
  await indexed([]);
  const file = join(OWNER_DATA_DIR, "truth", "people.yaml");
  const was = readFileSync(file, "utf8");
  writeFileSync(
    file,
    `${was}  - id: test-ana-two\n    name: Ana Two\n    aliases: [Test Ana]\n`
  );
  try {
    const read = (await person("Test Ana")) as {
      candidates: { ref: string }[];
      now: { ref: string };
    };
    expect(read.candidates.map((p) => p.ref)).toEqual([
      "person:test-ana",
      "person:test-ana-two",
    ]);
    expect(read.now.ref).toBe("person:test-ana");
  } finally {
    writeFileSync(file, was);
  }
});

test("a name a hundred go by: the candidates take a quarter of the room at most, the rest counted; the whole answer keeps within it", async () => {
  await indexed([]);
  const file = join(OWNER_DATA_DIR, "truth", "people.yaml");
  const was = readFileSync(file, "utf8");
  const many = Array.from(
    { length: 100 },
    (_, n) =>
      `  - id: test-ana-${n}\n    name: Ana Number ${n}\n    aliases: [Test Ana]\n`
  ).join("");
  writeFileSync(file, `${was}${many}`);
  try {
    const read = (await person("Test Ana")) as {
      candidates: unknown[];
      more?: { candidates: number };
    };
    expect(JSON.stringify(read).length).toBeLessThanOrEqual(PART_CHARS);
    expect(JSON.stringify(read.candidates).length).toBeLessThanOrEqual(
      PART_CHARS / 4
    );
    expect(read.candidates.length + (read.more?.candidates ?? 0)).toBe(101);
  } finally {
    writeFileSync(file, was);
  }
});

test("now reads only the episode files the index names for them: an earlier line's day and its latest, never another day's", async () => {
  const line = (day: string, id: string, title: string, people: string[]) =>
    `${JSON.stringify({ copies: [], day, end: null, id, importance: 2, madeBy, people: people.map((ref) => ({ ref, role: "with" })), place: null, schemaVersion: 1, start: `${day} 12:00`, title, units: ["unit_000000000001"], what: "They talk.", within: null })}\n`;
  const file = (day: string) => join(EPISODES, `${day}.jsonl`);
  mkdirSync(EPISODES, { recursive: true });
  try {
    writeFileSync(
      file("2026-10-01"),
      line("2026-10-01", "ep_00000000000a", "Lunch", ["person:test-ana"]) +
        // A tea the same day she was in until its latest line left her out: her lunch's day file holds its old line.
        line("2026-10-01", "ep_00000000000d", "Tea", ["person:test-ana"])
    );
    // The lunch read again a day later, now a walk too: its latest line.
    writeFileSync(
      file("2026-10-03"),
      line("2026-10-01", "ep_00000000000a", "Lunch, then a walk", [
        "person:test-ana",
      ]) +
        // A coffee she was in until its latest line, read a day later, left her out.
        line("2026-10-03", "ep_00000000000c", "Coffee", []) +
        line("2026-10-01", "ep_00000000000d", "Tea", [])
    );
    writeFileSync(
      file("2026-10-02"),
      line("2026-10-02", "ep_00000000000b", "Errands", []) +
        line("2026-10-02", "ep_00000000000c", "Coffee", ["person:test-ana"])
    );
    await reindex();
    // A day of no episode of hers, unreadable: reading it would throw.
    writeFileSync(file("2026-10-02"), "not an episode\n");
    const now = (await person("Test Ana")) as {
      episodes: { titles: string[] }[];
    };
    expect(now.episodes.flatMap((m) => m.titles)).toEqual([
      "Lunch, then a walk",
    ]);
    // An index from before `episode_people`: the read says it is being rebuilt, never reads every day (2 Oct would throw), and the index is stale.
    const db = new Database(INDEX);
    db.run("drop table episode_people");
    db.close();
    await expect(person("Test Ana")).rejects.toThrow("rebuilding its index");
    expect(readStaleness()).toBe("index");
  } finally {
    rmSync(EPISODES, { force: true, recursive: true });
  }
});

test("reach keeps to its room with long Contacts labels; every account it has no room for is in details; an organization's four addresses all show", () => {
  const phones = Array.from(
    { length: 40 },
    (_, n) => `+336000001${String(n).padStart(2, "0")}`
  );
  const label = "A very long Contacts label for this number ".repeat(4);
  const reach = reachOf({
    cards: [
      {
        addresses: [],
        birthday: null,
        handles: phones,
        id: "card-many",
        labels: Object.fromEntries(phones.map((p) => [p, label])),
        name: "Test Ana",
        profiles: [],
        related: [],
        work: null,
      },
    ],
    seen: [],
  });
  const now = personNowOf({
    communicationStyle: [],
    details: [],
    episodes: [],
    knows: [],
    matters: [],
    pictures: [],
    reach,
    row: row("person:test-ana"),
    situation: [],
    today: "2026-03-10",
  });
  expect(JSON.stringify(now).length).toBeLessThanOrEqual(PART_CHARS);
  const inReach = new Set(
    now.reach.flatMap((r) => r.accounts.map((a) => a.handle))
  );
  const inDetails = now.details.map((d) => d.text).join("\n");
  for (const phone of phones) {
    expect(inReach.has(phone) || inDetails.includes(phone)).toBe(true);
  }
  expect(inReach.size).toBeLessThan(phones.length);
  const mails = ["a", "b", "c", "d"].map((x) => `${x}@bakery.example.test`);
  const org = reachOf({
    cards: [],
    party: { handles: { email: mails, phone: [], whatsapp: [] } },
    seen: [],
  });
  expect(
    personNowOf({
      ...now,
      ...inputsOf(now),
      matters: [],
      reach: org,
    }).reach.flatMap((r) => r.accounts.map((a) => a.handle))
  ).toEqual(mails);
});

test("an organization's 120 addresses: following `moreReach` and each `next` through fetch gives every one, in order, each page within its room", async () => {
  const mails = Array.from(
    { length: 120 },
    (_, n) => `team${n}@bakery.example.test`
  );
  const subject = `test-${"b".repeat(400)}`;
  const reach = reachOf({
    cards: [],
    party: { handles: { email: mails, phone: [], whatsapp: [] } },
    seen: [],
  });
  // A Contacts label as long as the whole part: its end goes, the handle and link stay.
  const [{ accounts }] = reach as [Reach];
  (accounts[0] as { title?: string }).title = "Label 😀 ".repeat(800);
  const now = personNowOf({
    communicationStyle: [],
    details: [],
    episodes: [],
    knows: [],
    matters: [],
    pictures: [],
    reach,
    row: row(`person:${subject}`),
    situation: [],
    today: "2026-03-10",
  });
  const readPerson = (name: string, o: { part: string; span?: string }) => {
    // Every ref handed out names this subject's reach part.
    expect([name, o.part]).toEqual([subject, "reach"]);
    return Promise.resolve(
      reachPageOf(reach, Number(o.span ?? 0), `person:${name}`)
    );
  };
  const heard: string[] = [];
  let ref: string | undefined = now.moreReach;
  let pages = 0;
  while (ref) {
    // biome-ignore lint/performance/noAwaitInLoops: each page's ref comes from the one before
    const page = (await openById(ref, undefined, undefined, readPerson)) as {
      next?: string;
      reach: Reach[];
    };
    expect(JSON.stringify(page).length).toBeLessThanOrEqual(PART_CHARS);
    heard.push(...page.reach.flatMap((r) => r.accounts.map((a) => a.handle)));
    ref = page.next;
    pages += 1;
  }
  expect(pages).toBeGreaterThan(1);
  expect(heard).toEqual(mails);
});

test("his own situation is checked against the episodes the index holds, by the ids it cites: no episode file is read", async () => {
  const line = `${JSON.stringify({ copies: [], day: "2026-10-04", end: null, id: "ep_00000000000e", importance: 2, madeBy, people: [], place: null, schemaVersion: 1, start: "2026-10-04 12:00", title: "Moving day", units: ["unit_000000000001"], what: "He moves.", within: null })}\n`;
  const file = join(EPISODES, "2026-10-04.jsonl");
  mkdirSync(EPISODES, { recursive: true });
  writeJson(situationPath(OWNER), {
    built: "2026-11-05T00:00:00.000Z",
    inputs: "0123456789abcdef",
    lines: [
      { cites: ["ep_00000000000e"], text: "He moved flats." },
      { cites: ["ep_00000000000f"], text: "An episode since gone." },
    ],
    madeBy: { ...madeBy, prompt: promptNameOf("memory-situation.v3") },
    page: OWNER,
    schemaVersion: 1,
  });
  try {
    writeFileSync(file, line);
    await reindex();
    // Unreadable now: reading any episode file would throw.
    writeFileSync(file, "not an episode\n");
    const now = (await person("Test Owner")) as {
      situation: { text: string }[];
    };
    expect(now.situation.map((l) => l.text)).toEqual(["He moved flats."]);
  } finally {
    rmSync(EPISODES, { force: true, recursive: true });
    rmSync(situationPath(OWNER), { force: true });
  }
});

test("a conversation in person plays one span per recording, from its first turn's clip to its last's; a recording lifelog lost is left out", async () => {
  const store = lifelogStore();
  const at = (m: number) => `2026-10-14T10:0${m}:00.000Z`;
  const turn = (job: string, i: number, m: number) => ({
    ...turnFixture(i, at(m), null, null, "talk-a"),
    jobId: job,
  });
  apply(
    store,
    pageFixture({
      conversations: [conversation("talk-a")],
      turns: [
        turn("job-1", 0, 1),
        turn("job-1", 1, 2),
        turn("job-1", 2, 3),
        turn("job-2", 0, 4),
        turn("job-3", 0, 5),
      ],
    })
  );
  const asked: string[] = [];
  const spy = spyOn(voices, "readTurnClip").mockImplementation((job, i) => {
    asked.push(`${job}:${i}`);
    return Promise.resolve(
      job === "job-3"
        ? null
        : {
            at: null,
            audio: { end: i * 10 + 5, jobId: job, start: i * 10 },
            text: "",
            until: null,
            words: [],
          }
    );
  });
  try {
    const u = unitFixture({
      end: at(9),
      key: "talk-a",
      source: "lifelog",
      start: at(0),
    });
    expect(await readHeardAudio(u, () => store)).toEqual([
      { end: 25, jobId: "job-1", start: 0 },
      { end: 5, jobId: "job-2", start: 0 },
    ]);
    expect(asked.toSorted()).toEqual([
      "job-1:0",
      "job-1:2",
      "job-2:0",
      "job-3:0",
    ]);
  } finally {
    spy.mockRestore();
  }
});
