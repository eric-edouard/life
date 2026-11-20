import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { SourceEvent } from "../records/source";
import { buildIndex } from "./index-writer";
import { INDEX, UNITS } from "./memory-files";
import { writePassages } from "./passages";
import { unit as unitFixture } from "./record-fixtures";
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
  const units = [
    chatDay(1, direct, ["person:test-ana", "person:me"]),
    chatDay(2, group, ["person:test-ana", "unknown:Zed Moss", "person:me"]),
    chatDay(3, other, ["unknown:Zed Moss"]),
  ];
  const all = [...direct, ...group, ...other];
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
    // Each chat-day's span read once; Zed's own chat never.
    expect(reads).toHaveLength(2);
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
    expect(await chatsOf({ who: "Nobody Atall" }, { line })).toContain(
      "No one goes by Nobody Atall"
    );
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(INDEX, { force: true });
  }
});
