import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { eventKey, type SourceEvent } from "../records/source";
import {
  makeReplies,
  READS,
  readExchangeReadWork,
  readReplies,
  readReplyIndex,
  replyOf,
  storeReply,
} from "./exchange-reads";
import { exchangesOf } from "./exchanges";
import type { People } from "./who";

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
