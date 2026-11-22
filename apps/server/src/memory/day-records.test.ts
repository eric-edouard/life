import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stamp } from "../models/llm";
import type { Episode } from "../records/episode";
import {
  DAY_RECORD_READ,
  DayRecord,
  type ReadReply,
} from "../records/read-reply";
import { dayRecordInputOf } from "./day-records";
import { type DayParts, dayRecordsOf } from "./read-day";
import { makeReplies, readReplies } from "./read-replies";
import { readsOf, type Step } from "./run";

// Made-up days: a dinner with a made-up person, one episode, one fact.

const DAY = "2026-10-14";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "day-records-"));
});
afterAll(async () => {
  await rm(dir, { force: true, recursive: true });
});

const recordLine = (
  day: string,
  at: string,
  summary: string,
  prompt = "memory-day-record.v1"
) =>
  ({
    at,
    day,
    inputs: "0".repeat(16),
    madeBy: { engine: "codex", model: "test", prompt, run: "r1" },
    messages: ["ep_000000000001"],
    promptDigest: "0".repeat(16),
    read: DAY_RECORD_READ,
    reply: {
      headline: "A day",
      links: [],
      people: [],
      places: [],
      projects: [],
      summary,
    },
    schemaVersion: 1,
    starts: [0],
  }) as ReadReply;

test("dayRecordsOf keeps the newest line of each day, from the current prompt only", () => {
  const kept = dayRecordsOf([
    recordLine(DAY, "2026-10-15T01:00:00.000Z", "First."),
    recordLine(DAY, "2026-10-15T02:00:00.000Z", "Newest."),
    recordLine("2026-10-15", "2026-10-16T01:00:00.000Z", "Another day."),
    recordLine(
      "2026-10-13",
      "2026-10-14T01:00:00.000Z",
      "An old prompt's.",
      "memory-day-record.v0"
    ),
  ]);
  expect([...kept.keys()]).toEqual([DAY, "2026-10-15"]);
  expect(kept.get(DAY)?.reply.summary).toBe("Newest.");
});

/** A day's parts with one episode and one fact, both naming `name`. */
const partsOf = (name: string, episode = "ep_000000000001"): DayParts => ({
  actions: [],
  born: [],
  done: [],
  due: [],
  episodes: [
    {
      episode: {
        day: DAY,
        id: episode,
        people: [{ ref: `unknown:${name}`, role: "with" }],
        title: `Dinner with ${name}`,
        units: [],
        what: null,
      } as unknown as Episode,
      facts: [],
    },
  ],
  facts: [`- obs_000000000001 ${DAY} todo: Dinner with ${name} "come at 8"`],
  payments: [],
  refs: {
    episodes: [episode],
    facts: ["obs_000000000001"],
    payments: [],
    summaries: [],
  },
  summaries: [],
  units: [],
  whereUnknown: false,
});

test("a day record's digest rests on ids: a person's name changing moves it not, an episode id does", () => {
  const truth = { projects: [] };
  const before = dayRecordInputOf(DAY, partsOf("Alma"), [], truth);
  const renamed = dayRecordInputOf(DAY, partsOf("Hugo"), [], truth);
  expect(renamed.digest).toBe(before.digest);
  expect(renamed.input.day_lines).not.toBe(before.input.day_lines);
  const other = dayRecordInputOf(
    DAY,
    partsOf("Alma", "ep_000000000002"),
    [],
    truth
  );
  expect(other.digest).not.toBe(before.digest);
  expect(before.input).not.toHaveProperty("earlier");
});

test("a reply without its summary is refused and nothing is stored", async () => {
  const where = join(dir, "trial");
  const step = {
    ask: () => Promise.resolve({ headline: "Only a headline" }),
    attempt: (work: () => Promise<unknown>) => work().catch(() => undefined),
    dir: join(dir, "run"),
    end: (counts: unknown) => counts,
    keeps: () => false,
    llm: { engine: "codex", model: "test" },
    madeBy: (prompt: string) =>
      stamp({ engine: "codex", model: "test" }, prompt, "r1"),
    run: "r1",
  } as unknown as Step;
  const made = await makeReplies(
    [
      {
        at: "2026-10-15T00:00:00.000Z",
        call: {
          checked: (r) => DayRecord.parse(r),
          day: DAY,
          firstAt: `${DAY}T00:00:00.000Z`,
          input: {},
          inputs: "0".repeat(16),
          keys: ["ep_000000000001"],
          reads: readsOf([]),
          starts: [0],
        },
        read: DAY_RECORD_READ,
      },
    ],
    step,
    where
  );
  expect(made.stored).toBe(0);
  expect(readReplies(where).flat()).toEqual([]);
});
