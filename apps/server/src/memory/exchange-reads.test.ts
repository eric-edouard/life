import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { eventKey, type SourceEvent } from "../records/source";
import { Person } from "../records/truth";
import {
  callOf,
  directCallOf,
  makeReplies,
  namedEarlierOf,
  READS,
  readExchangeReadWork,
  readReplies,
  readReplyIndex,
  replyOf,
  storeReply,
} from "./exchange-reads";
import { exchangesOf } from "./exchanges";
import { refContext } from "./model-context";
import { tiesNow } from "./ties";
import { foldsOf, type People } from "./who";

const START = Date.parse("2026-10-01T12:00:00.000Z");
const msg = (ms: number, fromMe: boolean, text = "hello"): SourceEvent => ({
  at: new Date(START + ms).toISOString(),
  chat: "+1",
  fromMe,
  id: String(ms),
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text,
});
const people = {
  nameOf: () => "Ann",
  resolve: (s: string) => (s === "+1" ? "person:ann" : null),
  truth: { people: [] },
} as unknown as People;
// Two exchanges a day apart, both finished by `LATER`.
const talk = [
  msg(0, false),
  msg(1000, true),
  msg(30 * HOUR, false),
  msg(30 * HOUR + 1000, true),
];
const LATER = new Date(START + 60 * HOUR);
const GIVEN = { exchanges: [{ exchange: 0, moves: [] }], extra: "kept" };

let dir = "";
let where = "";
let n = 0;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "reads-"));
});
afterAll(() => rm(dir, { force: true, recursive: true }));
// A trial file of its own for each test.
const fresh = () => {
  n += 1;
  where = join(dir, `trial-${n}`);
};

let asked = 0;
const stepOf = (reply: unknown) => ({
  ask: () => {
    asked += 1;
    return Promise.resolve(reply);
  },
  // As a run's `attempt`: a failure costs that piece only.
  attempt: (work: () => Promise<unknown>) => work().catch(() => undefined),
  dir: join(dir, "run"),
  llm: { engine: "codex", model: "test" },
  run: "r1",
});
const workOf = (events: SourceEvent[], now = LATER) =>
  readExchangeReadWork({ events, failed: [] }, people, now, where);
const readAll = async (events: SourceEvent[], reply: unknown = GIVEN) => {
  const work = workOf(events);
  await makeReplies(work?.work ?? [], stepOf(reply) as never, where);
  return work;
};
const lines = () => readReplies(where).flat();
const heldBy = (exchange: SourceEvent[] | undefined) =>
  replyOf(exchange ?? [], "connection", readReplyIndex(where));

test("every finished exchange is asked once per read, stored as given; a growing chat asks nothing again", async () => {
  fresh();
  const before = asked;
  const work = await readAll(talk);
  expect(work?.counts).toEqual({ calls: 3, exchanges: 6 });
  expect(asked - before).toBe(3);
  expect(
    lines()
      .map((l) => [l.read, l.starts, l.messages.length])
      .sort()
  ).toEqual([
    ["conflict", [0, 2], 4],
    ["connection", [0, 2], 4],
    ["mentions", [0, 2], 4],
  ]);
  expect(lines()[0]?.reply).toEqual(GIVEN);
  // A new exchange, not finished yet, is not asked; nothing old is asked again.
  expect(workOf([...talk, msg(59 * HOUR, false)])?.work).toEqual([]);
  // Finished at six hours, not before.
  const last = START + 59 * HOUR;
  expect(
    workOf([...talk, msg(59 * HOUR, false)], new Date(last + 6 * HOUR - 60_000))
      ?.work
  ).toEqual([]);
  expect(
    workOf([...talk, msg(59 * HOUR, false)], new Date(last + 6 * HOUR))?.work
  ).toHaveLength(3);
});

test("an exchange that gained a message is asked once, and the newer line wins", async () => {
  fresh();
  await readAll(talk);
  const filled = [...talk, msg(30 * HOUR + 2000, false, "late")];
  const [first, second] = exchangesOf(filled);
  expect(workOf(filled)?.counts).toEqual({ calls: 3, exchanges: 3 });
  await readAll(filled, { exchanges: [], newer: true });
  expect(heldBy(first)?.line.reply).toEqual(GIVEN);
  expect(heldBy(second)?.line.reply).toEqual({ exchanges: [], newer: true });
  expect(workOf(filled)?.work).toEqual([]);
  // The old line was not rewritten: the file only grew.
  expect(lines()).toHaveLength(6);
});

test("a new prompt version asks again and rewrites nothing; the same version with another digest asks nothing", () => {
  fresh();
  const [first] = exchangesOf(talk);
  const line = (prompt: string, wording: string) => ({
    at: "2026-10-04T00:00:00.000Z",
    madeBy: { engine: "codex" as const, model: "m", prompt, run: "r" },
    messages: talk.map(eventKey),
    promptDigest: wording,
    read: "connection" as const,
    reply: GIVEN,
    schemaVersion: 1 as const,
    starts: [0, 2],
  });
  storeReply(
    line("memory-connection.v2", "a".repeat(16)),
    talk[0]?.at ?? "",
    where
  );
  expect(heldBy(first)).toBeUndefined();
  expect(
    workOf(talk)?.work.filter((w) => w.read === "connection")
  ).toHaveLength(1);
  storeReply(
    line(READS.connection.prompt, "b".repeat(16)),
    talk[0]?.at ?? "",
    where
  );
  expect(heldBy(first)?.line.promptDigest).toBe("b".repeat(16));
  expect(
    workOf(talk)
      ?.work.map((w) => w.read)
      .sort()
  ).toEqual(["conflict", "mentions"]);
  expect(lines()).toHaveLength(2);
});

test("an exchange the model skipped stays read; a failed call or a non-reply stores nothing", async () => {
  fresh();
  const skipping = { exchanges: [{ exchange: 0, moves: [] }] };
  await readAll(talk, skipping);
  const [, second] = exchangesOf(talk);
  expect(heldBy(second)?.index).toBe(1);
  expect(workOf(talk)?.work).toEqual([]);

  fresh();
  for (const reply of [{ nope: true }, null, "text"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one try after another
    await readAll(talk, reply);
  }
  const failing = {
    ...stepOf(null),
    ask: () => Promise.reject(new Error("down")),
  };
  await makeReplies(workOf(talk)?.work ?? [], failing as never, where);
  expect(lines()).toHaveLength(0);
  expect(workOf(talk)?.work).toHaveLength(3);
});

test("a night asks the newest calls first within its cap; a failed source gives nothing", () => {
  fresh();
  // 70 exchanges, each too big to share a call: 210 calls over the three reads, 200 a night.
  const big = "x".repeat(16_000);
  const many = Array.from({ length: 70 }, (_, i) => [
    msg(i * 12 * HOUR, false, big),
    msg(i * 12 * HOUR + 1000, true, big),
  ]).flat();
  const work = readExchangeReadWork(
    { events: many, failed: [] },
    people,
    new Date(START + 900 * HOUR),
    where
  );
  expect(work?.counts.calls).toBe(210);
  expect(work?.work).toHaveLength(200);
  const oldest = new Date(START).toISOString();
  expect(work?.work.some((w) => w.at === oldest)).toBe(false);
  expect(
    work?.work.some(
      (w) => w.at === new Date(START + 69 * 12 * HOUR).toISOString()
    )
  ).toBe(true);
  expect(
    readExchangeReadWork(
      { events: many, failed: ["mail"] },
      people,
      LATER,
      where
    )
  ).toBeNull();
});

test("a reply is filed under the month of its first message, not of when it was made; folders read oldest month first", () => {
  fresh();
  const line = (first: SourceEvent[]) => ({
    at: "2026-11-13T09:00:00.000Z",
    madeBy: { engine: "codex" as const, model: "m", prompt: "p", run: "r" },
    messages: first.map(eventKey),
    promptDigest: "a".repeat(16),
    read: "connection" as const,
    reply: GIVEN,
    schemaVersion: 1 as const,
    starts: [0],
  });
  const [oct] = talk;
  const spring = msg(-200 * 24 * HOUR, false);
  // Made today, both: the later month is stored first, yet comes back second.
  storeReply(line([oct as SourceEvent]), oct?.at ?? "", where);
  storeReply(line([spring]), spring.at, where);
  expect(readdirSync(where).sort()).toEqual(["2026-03.jsonl", "2026-10.jsonl"]);
  expect(readReplies(where).map((f) => f.map((l) => l.messages[0]))).toEqual([
    [eventKey(spring)],
    [eventKey(oct as SourceEvent)],
  ]);
});

const CLOCK = /\d\d:\d\d/;
const KNOWN = [
  ["hugo-blanc", "Hugo Blanc", "friend", ["Hugo"]],
  ["lea-morel", "Léa Morel", "sister", ["Léa"]],
  ["anne-morel", "Anne Morel", "mother", []],
] as const;
// A directory of 500 made-up people beside the three the call names.
const crowd = Array.from({ length: 500 }, (_, i) => ({
  aliases: [],
  id: `filler-${i}`,
  name: `Filler Person${i}`,
  relation: "neighbour",
}));
const directoryPeople = [
  ...KNOWN.map(([id, name, relation, aliases]) => ({
    aliases: [...aliases],
    id,
    name,
    relation,
  })),
  ...crowd,
];
const folded = foldsOf(
  directoryPeople.map((p) => Person.parse(p)),
  [],
  [],
  []
);
const crowded = {
  ...folded,
  names: new Map(directoryPeople.map((p) => [`person:${p.id}`, p.name])),
  outsideDirectory: [],
  truth: {
    areas: [],
    me: { text: "" },
    people: directoryPeople,
    projects: [],
  },
};
const room = (min: number, sender: string, text: string): SourceEvent => ({
  ...msg(min * 60_000, sender === "me", text),
  chat: "room",
  sender,
});
const crowdedTies = tiesNow(crowded as never);
const directory = refContext(crowded as never, new Set(), new Set());

test("a call with three speakers shows each by name, the earlier lines that name someone, and involves only its speakers and whom its lines name, whatever the directory's size", () => {
  const earlier = [
    room(0, "me", "Léa a encore annulé dimanche"),
    room(1, "me", "ma mère dit que c'est le boulot"),
    room(2, "me", "Léa encore"),
    room(3, "me", "rien de spécial"),
  ];
  const batch = [
    [
      room(10, "Hugo Blanc", "elle abuse"),
      room(11, "unknown voice 1", "mon frère aussi"),
    ],
  ];
  const call = callOf(batch, crowded as never, crowdedTies, directory, earlier);
  expect(call.input.lines.map((l) => l.replace(CLOCK, "HH:MM"))).toEqual([
    "## Earlier in this conversation",
    "[0] HH:MM me: ma mère dit que c'est le boulot",
    "[1] HH:MM me: Léa encore",
    "## Exchange 2 · 2026-10-01",
    "[2] HH:MM Hugo Blanc: elle abuse",
    "[3] HH:MM unknown voice 1: mon frère aussi",
  ]);
  expect(call.starts).toEqual([2]);
  expect(call.messages).toHaveLength(4);
  // Hugo speaks and Life places him; Léa and Anne are named on earlier lines; the 500 others are not in the call.
  expect(call.input.involved.map((p) => p.ref).sort()).toEqual([
    "person:anne-morel",
    "person:hugo-blanc",
    "person:lea-morel",
  ]);
  expect(call.earlierCut).toBe(false);
});

test("the earlier lines are the latest per person named, twelve at most", () => {
  const earlier = crowd
    .slice(0, 15)
    .map((p, i) => room(i, "me", `${p.name} est venu`));
  const { cut, events } = namedEarlierOf(
    earlier,
    crowded as never,
    crowdedTies
  );
  expect(cut).toBe(true);
  expect(events).toHaveLength(12);
  expect(events.at(-1)).toBe(earlier[14] as SourceEvent);
});

test("the live calls are unchanged: the prompts' names, the two-person input, and what the night asks", () => {
  expect(READS).toEqual({
    conflict: { prompt: "memory-conflict.v2" },
    connection: { prompt: "memory-connection.v3" },
    mentions: { prompt: "memory-mentions.v1" },
  });
  const call = directCallOf([talk], { name: "Ann", relation: "friend" });
  expect(Object.keys(call.input)).toEqual(["lines", "with"]);
  fresh();
  const work = workOf(talk);
  expect(work?.work.map((w) => w.prompt).sort()).toEqual([
    READS.conflict.prompt,
    READS.connection.prompt,
    READS.mentions.prompt,
  ]);
  expect(Object.keys(work?.work[0]?.call.input ?? {}).sort()).toEqual([
    "lines",
    "with",
  ]);
});

test("a trial folder's index goes by the prompt it is given, the night's by the live one", () => {
  fresh();
  const wordingTwo = "memory-mentions.v2";
  storeReply(
    {
      at: "2026-10-04T00:00:00.000Z",
      madeBy: { engine: "codex", model: "m", prompt: wordingTwo, run: "r" },
      messages: talk.map(eventKey),
      promptDigest: "c".repeat(16),
      read: "mentions",
      reply: GIVEN,
      schemaVersion: 1,
      starts: [0, 2],
    },
    talk[0]?.at ?? "",
    where
  );
  const [first] = exchangesOf(talk);
  expect(replyOf(first ?? [], "mentions", readReplyIndex(where))).toBe(
    undefined
  );
  expect(
    replyOf(
      first ?? [],
      "mentions",
      readReplyIndex(where, () => wordingTwo)
    )?.line.promptDigest
  ).toBe("c".repeat(16));
});
