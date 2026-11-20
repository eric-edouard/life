import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import type { SourceEvent } from "../records/source";
import { buildIndex, reindexUnits } from "./index-writer";
import { INDEX, UNITS } from "./memory-files";
import { writePassages } from "./passages";
import { unit as unitFixture } from "./record-fixtures";
import { messageUnits } from "./units";
import { readPeople } from "./who";
import { chatHits, chatsOf, mailHits } from "./words";

const event = (
  id: string,
  at: string,
  source: SourceEvent["source"] = "line"
): SourceEvent => ({
  at,
  chat: source === "claude" ? "claude:old-room" : "old-room",
  chatName: "Old room",
  fromMe: true,
  id,
  sender: "owner",
  source,
  text: "The ancient cobalt plan",
});

test("stored ancient chats and pruned assistant writing remain searchable without any source scan", async () => {
  const all = [
    event("a", "2001-02-01T12:00:00.000Z"),
    event("b", "2001-02-02T12:00:00.000Z", "claude"),
  ];
  writePassages(all, { from: "2001-02-01", to: "2001-02-02" }, [], {
    claude: () => [],
    line: () => [],
  });
  const hits = (await chatHits("ancient cobalt")).join("\n");
  expect(hits).toContain("(line, chat old-room)");
  expect(hits).toContain("(claude, fetch claude:old-room)");
  expect(
    (await chatHits("cobalt", { from: "2002-01-01" })).join("\n")
  ).not.toContain("ancient cobalt");
});

test("stored ancient mail retains its owning thread-day fetch id", async () => {
  writePassages(
    [
      {
        ...event("mail:a", "2001-03-01T12:00:00.000Z", "mail"),
        text: "Old room\nThe ancient cobalt plan",
      },
    ],
    { from: "2001-03-01", to: "2001-03-01" },
    [],
    { mail: () => [] }
  );
  const hits = await mailHits("ancient cobalt");
  expect(hits).toHaveLength(1);
  expect(hits[0]).toStartWith("- unit_");
  expect(hits[0]).toContain("ancient cobalt");
});

/** A unit of `events`' chat-day, filed with `people` as the index lists them. */
const chatDay = (n: number, events: SourceEvent[], people: string[]) =>
  unitFixture({
    date: (events[0] as SourceEvent).at.slice(0, 10),
    end: (events.at(-1) as SourceEvent).at,
    id: `unit_${String(n).padStart(12, "0")}`,
    key: (events[0] as SourceEvent).chat,
    people,
    source: "line",
    start: (events[0] as SourceEvent).at,
  });

test("who: their one-to-one chats whole and their own words in groups, deleted ones included, through their units; before pages back", async () => {
  const say = (
    id: string,
    at: string,
    chat: string,
    sender: string,
    text: string,
    over: Partial<SourceEvent> = {}
  ): SourceEvent => ({
    at: `2001-02-${at}:00.000Z`,
    chat,
    chatName: chat,
    fromMe: sender === "me",
    id,
    sender,
    source: "line",
    text,
    ...over,
  });
  const direct = [
    say("a1", "01T10:00", "ana-room", "Test Ana", "Hello there"),
    say("a2", "01T10:05", "ana-room", "me", "Hi Ana"),
    say("a3", "01T10:06", "ana-room", "Test Ana", "Taken back", {
      deleted: true,
    }),
  ];
  const group = [
    say("g1", "02T09:00", "climbing", "Test Ana", "I am in"),
    say("g2", "02T09:01", "climbing", "Zed Moss", "Me too"),
    say("g3", "02T09:02", "climbing", "me", "Great"),
  ];
  const other = [say("z1", "03T09:00", "zed-room", "Zed Moss", "Zed alone")];
  // A handle no one is known by: its own units, filed as written.
  const stranger = [
    say("s1", "04T09:00", "+66600000009", "+66600000009", "Who is this"),
  ];
  const units = [
    chatDay(1, direct, ["person:test-ana", "person:me"]),
    chatDay(2, group, ["person:test-ana", "unknown:Zed Moss", "person:me"]),
    chatDay(3, other, ["unknown:Zed Moss"]),
    chatDay(4, stranger, ["unknown:+66600000009"]),
  ];
  const all = [...direct, ...group, ...other, ...stranger];
  const reads: string[] = [];
  const line = (from: Date, to?: Date) => {
    reads.push(from.toISOString());
    return all.filter(
      (e) => e.at >= from.toISOString() && (!to || e.at < to.toISOString())
    );
  };
  mkdirSync(UNITS, { recursive: true });
  mkdirSync(dirname(INDEX), { recursive: true });
  try {
    for (const u of units) {
      writeFileSync(join(UNITS, `${u.date}.jsonl`), `${JSON.stringify(u)}\n`);
    }
    buildIndex(
      [],
      INDEX,
      {
        corrections: [],
        live: new Set(),
        retired: new Map(),
        standing: new Map(),
      },
      units.map((unit) => ({ unit }))
    );
    const shown = (text: string | null) =>
      (text ?? "").split("\n").filter((l) => l.includes("[id "));
    const found = shown(await chatsOf({ who: "Test Ana" }, { line }));
    // The messages the name scan over every chat gave: the 1:1 chat whole, her own line in the group.
    expect(found.map((l) => l.slice(l.indexOf(" ") + 1))).toEqual([
      "10:00 Test Ana: Hello there [id a1]",
      "10:05 me: Hi Ana [id a2]",
      "10:06 Test Ana: Taken back (deleted) [id a3]",
      "09:00 Test Ana: I am in [id g1]",
    ]);
    // Today read once, then each chat-day's span once; Zed's own chat never.
    expect(reads).toHaveLength(3);
    const older = shown(
      await chatsOf(
        { before: "2001-02-02T00:00:00.000Z", who: "Test Ana" },
        { line }
      )
    );
    expect(older.map((l) => l.slice(l.lastIndexOf("[")))).toEqual([
      "[id a1]",
      "[id a2]",
      "[id a3]",
    ]);
    expect(
      shown(await chatsOf({ who: "+66600000009" }, { line }))
    ).toHaveLength(1);
    expect(await chatsOf({ who: "Nobody Atall" }, { line })).toContain(
      "No one goes by Nobody Atall"
    );
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});

/** `events` made into units by the night's own builder, stored and indexed as the watcher indexes them. */
async function indexedFrom(events: SourceEvent[]) {
  const units = messageUnits(events, (await readPeople()).resolve).map(
    (b) => b.unit
  );
  mkdirSync(UNITS, { recursive: true });
  mkdirSync(dirname(INDEX), { recursive: true });
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
}

/** Lines of a `read_chats` answer that are messages. */
const messagesIn = (text: string | null) =>
  (text ?? "").split("\n").filter((l) => l.includes("[id "));

test("who: a 1:1 chat-day only he wrote in is theirs (its key names them), and today's message not indexed yet is read too", async () => {
  const people = join(OWNER_DATA_DIR, "truth", "people.yaml");
  const was = await Bun.file(people).text();
  // Test Ana's WhatsApp number, his directory's word: the chat's key names her.
  await Bun.write(
    people,
    was.replace(
      "    name: Test Ana\n",
      '    name: Test Ana\n    handles: { whatsapp: ["+33600000001"] }\n'
    )
  );
  const chat = "33600000001@s.whatsapp.net";
  const mine = (id: string, at: string, text: string): SourceEvent => ({
    at,
    chat,
    fromMe: true,
    id,
    sender: "me",
    source: "whatsapp",
    text,
  });
  const sent = mine("w1", "2026-11-02T09:00:00.000Z", "Are you free Sunday?");
  const today = mine("w2", new Date().toISOString(), "On my way");
  const whatsapp = (from: Date, to?: Date) =>
    [sent, today].filter(
      (e) => e.at >= from.toISOString() && (!to || e.at < to.toISOString())
    );
  try {
    await indexedFrom([sent]);
    const found = messagesIn(await chatsOf({ who: "Test Ana" }, { whatsapp }));
    expect(found.map((l) => l.slice(l.lastIndexOf("[")))).toEqual([
      "[id w1]",
      "[id w2]",
    ]);
  } finally {
    await Bun.write(people, was);
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});

test("who: a busy day past the cursor, or in other chats than `chat`, never hides the older messages nor ends the pages early", async () => {
  const say = (day: string, chat: string, n: number): SourceEvent => ({
    at: new Date(
      Date.parse(`2001-02-${day}T10:00:00.000Z`) + n * 1000
    ).toISOString(),
    chat,
    chatName: chat,
    fromMe: false,
    id: `${day}-${chat}-${n}`,
    sender: "Test Ana",
    source: "line",
    text: `message ${n}`,
  });
  // 40 messages in her own chat; the next day, past the cursor, 6 of hers in each of 40 rooms (a round of units, 240 messages).
  const older = Array.from({ length: 40 }, (_, n) => say("01", "ana-room", n));
  const busy = Array.from({ length: 240 }, (_, n) =>
    say("02", `room-${n % 40}`, n)
  );
  const all = [...older, ...busy];
  const line = (from: Date, to?: Date) =>
    all.filter(
      (e) => e.at >= from.toISOString() && (!to || e.at < to.toISOString())
    );
  try {
    await indexedFrom(all);
    const page = await chatsOf(
      { before: "2001-02-02T09:00:00.000Z", who: "Test Ana" },
      { line }
    );
    expect(messagesIn(page)).toHaveLength(40);
    expect(page).not.toContain("earlier not shown");
    // `chat` with `who` is counted before the page is cut too.
    expect(
      messagesIn(
        await chatsOf(
          {
            before: "2001-02-03T00:00:00.000Z",
            chat: "ana-room",
            who: "Test Ana",
          },
          { line }
        )
      )
    ).toHaveLength(40);
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});

/** A LINE message (made-up), `fromMe` when its sender is "me". */
const lineSaid = (
  id: string,
  at: string,
  chat: string,
  sender: string,
  chatName = chat
): SourceEvent => ({
  at,
  chat,
  chatName,
  fromMe: sender === "me",
  id,
  sender,
  source: "line",
  text: `said ${id}`,
});

/** A source reading `all` between its bounds. */
const sourceOver =
  (all: SourceEvent[]) =>
  (from: Date, to?: Date): SourceEvent[] =>
    all.filter(
      (e) => e.at >= from.toISOString() && (!to || e.at < to.toISOString())
    );

test("who: a day only he wrote in a LINE room her name names is hers; so is a message he sent today to a number no one is known by", async () => {
  const room = lineSaid(
    "l1",
    "2001-03-01T09:00:00.000Z",
    "!room-ana",
    "me",
    "Test Ana"
  );
  const fresh: SourceEvent = {
    at: new Date().toISOString(),
    chat: "+66600000009",
    fromMe: true,
    id: "i1",
    sender: "me",
    source: "imessage",
    text: "Is this the plumber?",
  };
  try {
    await indexedFrom([room]);
    const line = sourceOver([room]);
    const imessage = sourceOver([fresh]);
    expect(
      messagesIn(await chatsOf({ who: "Test Ana" }, { imessage, line }))
    ).toHaveLength(1);
    expect(
      messagesIn(await chatsOf({ who: "+66600000009" }, { imessage, line }))
    ).toHaveLength(1);
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});

test("who: when the page's last two messages share an instant, it still looks for an older one and gives the next page", async () => {
  const at = (day: string, s: number) =>
    new Date(
      Date.parse(`2001-02-${day}T10:00:00.000Z`) + s * 1000
    ).toISOString();
  // A round of 40 rooms on the 2nd, 201 messages, the two oldest at one instant; 5 more on the 1st.
  const busy = Array.from({ length: 201 }, (_, n) =>
    lineSaid(`b${n}`, at("02", Math.max(n, 1)), `room-${n % 40}`, "Test Ana")
  );
  const older = Array.from({ length: 5 }, (_, n) =>
    lineSaid(`o${n}`, at("01", n), "ana-room", "Test Ana")
  );
  const line = sourceOver([...older, ...busy]);
  try {
    await indexedFrom([...older, ...busy]);
    const page = await chatsOf({ who: "Test Ana" }, { line });
    expect(messagesIn(page)).toHaveLength(201);
    expect(page).toContain(
      `(earlier not shown: the same call with \`before\` ${at("02", 1)})`
    );
    expect(
      messagesIn(
        await chatsOf({ before: at("02", 1), who: "Test Ana" }, { line })
      )
    ).toHaveLength(5);
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});

test("who: in a LINE group, a `from` after another member spoke never makes the rest look like her 1:1 chat", async () => {
  const group = [
    lineSaid("g1", "2001-04-01T09:00:00.000Z", "climbing", "Zed Moss"),
    lineSaid("g2", "2001-04-01T10:00:00.000Z", "climbing", "Test Ana"),
    lineSaid("g3", "2001-04-01T10:05:00.000Z", "climbing", "me"),
  ];
  try {
    await indexedFrom(group);
    const found = messagesIn(
      await chatsOf(
        {
          before: "2001-04-01T12:00:00.000Z",
          from: "2001-04-01T09:30:00.000Z",
          who: "Test Ana",
        },
        { line: sourceOver(group) }
      )
    );
    expect(found.map((l) => l.slice(l.lastIndexOf("[")))).toEqual(["[id g2]"]);
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});
