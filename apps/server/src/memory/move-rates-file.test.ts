import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { HOUR } from "../core/clock";
import type { ReadName } from "../records/read-reply";
import { eventKey, type SourceEvent } from "../records/source";
import { READS, storeReply } from "./exchange-reads";
import { MOVE_RATES, READ_REPLIES } from "./ledger";
import { readMoveRates, writeMoveRates } from "./move-rates-file";

const START = Date.parse("2026-10-01T12:00:00.000Z");
const TEXT = "how was the trip today";
const resolve = (s: string) =>
  ({ "+1": "person:ann", "+2": "person:bob", "+3": "person:carol" })[s] ?? null;

/** `count` exchanges of one chat, 10 hours apart: they write, he answers a minute later. */
const talk = (chat: string, count: number): SourceEvent[] =>
  Array.from({ length: count }, (_, i) => {
    const at = START + i * 10 * HOUR;
    return [false, true].map(
      (fromMe, j): SourceEvent => ({
        at: new Date(at + j * 60_000).toISOString(),
        chat,
        fromMe,
        id: `${chat}:${i}:${j}`,
        sender: fromMe ? "me" : chat,
        source: "whatsapp",
        text: TEXT,
      })
    );
  }).flat();

/** Stores one line of `read` listing every exchange of these events (two messages each), `code` found by him in the first `n`. */
function store(
  read: ReadName,
  events: SourceEvent[],
  codes: string[],
  n: number,
  prompt?: string
) {
  const starts = Array.from({ length: events.length / 2 }, (_, i) => i * 2);
  const extra = { on: "self", resource: "money" };
  storeReply(
    {
      at: "2026-11-01T00:00:00.000Z",
      madeBy: {
        engine: "claude",
        model: "test",
        prompt: prompt ?? READS[read].prompt,
        run: "r1",
      },
      messages: events.map(eventKey),
      read,
      reply: {
        exchanges: starts.map((exchange, i) => ({
          exchange,
          moves:
            i < n
              ? codes.map((code) => ({
                  code,
                  line: exchange + 1,
                  quote: TEXT,
                  ...extra,
                }))
              : [],
        })),
      },
      schemaVersion: 1,
      starts,
      wording: "0123456789abcdef",
    },
    events[0]?.at ?? "",
    READ_REPLIES
  );
}

afterEach(() => {
  rmSync(READ_REPLIES, { force: true, recursive: true });
  rmSync(MOVE_RATES, { force: true });
});

test("only share rows and the named conduct rows are kept, each with its place among the people", () => {
  const ann = talk("+1", 16);
  const bob = talk("+2", 16);
  store("connection", ann, ["asks_about", "returns"], 16);
  store("conflict", ann, ["blames"], 3);
  store("connection", bob, ["asks_about"], 4);
  const done = writeMoveRates(
    { events: [...ann, ...bob], failed: [] },
    resolve,
    "2026-11"
  );
  expect(done).toEqual({ failed: 0, people: 2 });
  const file = readMoveRates();
  const row = (ref: string, thing: string, side: string) =>
    file?.people[ref]?.rows.find((r) => r.thing === thing && r.side === side);
  expect(file?.people["person:ann"]?.exchanges).toBe(16);
  expect(row("person:ann", "asks_about", "me")).toMatchObject({
    above: 0,
    all: { n: 16, of: 16 },
    among: 1,
    below: 1,
    says: "share",
    source: "whatsapp",
  });
  expect(row("person:bob", "asks_about", "me")).toMatchObject({
    above: 1,
    among: 1,
    below: 0,
  });
  // Not proven but named: counted raw, no place. One nobody did is not kept.
  expect(row("person:ann", "blames", "me")).toMatchObject({
    above: 0,
    all: { n: 3, of: 16 },
    among: 0,
    says: "exploratory",
  });
  expect(row("person:ann", "blames", "them")).toBeUndefined();
  // Not proven and not named: dropped, whatever the count.
  expect(row("person:ann", "returns", "me")).toBeUndefined();
  expect(
    file?.people["person:bob"]?.rows.some((r) => r.says === "exploratory")
  ).toBe(false);
});

test("an exchange with no reply of the current prompt counts nothing, nor one that gained a message since", () => {
  const carol = talk("+3", 16);
  store("connection", carol, ["asks_about"], 16);
  // Ann's line was made by a prompt that is not the read's current one.
  const ann = talk("+1", 16);
  store("connection", ann, ["asks_about"], 16, "memory-connection.v1");
  const grown: SourceEvent[] = [
    ...carol,
    {
      ...(carol.at(-1) as SourceEvent),
      at: new Date(Date.parse(carol.at(-1)?.at ?? "") + 1000).toISOString(),
      id: "late",
    },
  ];
  // Carol's last exchange grew, so 15 of her 16 are held.
  writeMoveRates(
    { events: [...grown, ...ann], failed: [] },
    resolve,
    "2026-11"
  );
  const file = readMoveRates();
  expect(file?.people["person:ann"]).toBeUndefined();
  expect(file?.people["person:carol"]?.exchanges).toBe(15);
});

test("a failed source keeps the last file", () => {
  const ann = talk("+1", 16);
  store("connection", ann, ["asks_about"], 16);
  writeMoveRates({ events: ann, failed: [] }, resolve, "2026-11");
  const before = readMoveRates();
  expect(before?.people["person:ann"]).toBeDefined();
  expect(
    writeMoveRates({ events: [], failed: ["mail"] }, resolve, "2026-11")
  ).toEqual({ failed: 1, people: 0 });
  expect(readMoveRates()).toEqual(before);
});
