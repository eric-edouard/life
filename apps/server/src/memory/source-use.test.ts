import { expect, test } from "bun:test";
import type { LogEvent } from "../core/log";
import type { Descriptor } from "../sources/contract";
import { sourceUseLine, sourceUseOf, sourceUseText } from "./source-use";

const read = () => [];
const chat = {
  incoming: () => ({ end: 0, rows: [] }),
  kind: "chat",
  label: "WhatsApp",
  name: "whatsapp",
  read,
} as unknown as Descriptor;
const notes = {
  kind: "own_writing",
  label: "Notes",
  name: "notes",
  read,
} as unknown as Descriptor;
const voice = {
  kind: "voice",
  label: "Pendant",
  name: "lifelog",
  read,
} as unknown as Descriptor;

// A run's id is its start instant.
const N = "2026-11-17T00-31-00.000Z";
const X = "2026-11-17T00-40-00.000Z";
const C = "2026-11-18T09-00-00.000Z";
const run = (kind: string, step: string, at: string, id: string) => ({
  at,
  kind,
  run: id,
  step,
});
const call = (at: string, id: string, more: Record<string, unknown>) => ({
  at,
  engine: "openrouter",
  kind: "model.run",
  run: id,
  step: "",
  tokens: { cached: 0, input: 900, output: 100 },
  ...more,
});

test("source use: items and units a day as median and max, reads per unit, a call split over its sources by unit share, the memory row, unpriced calls, a step grouped under its night", () => {
  const events = [
    run("run.start", "memory.nightly", "2026-11-17T00:31:00.000Z", N),
    run("run.start", "memory.extract", "2026-11-17T00:40:00.000Z", X),
    // Three whatsapp chat-days and one lifelog conversation-day: a quarter of it is the pendant's.
    call("2026-11-17T00:41:00.000Z", X, {
      costUsd: 0.4,
      reads: { lifelog: 1, whatsapp: 3 },
    }),
    run("run.end", "memory.extract", "2026-11-17T00:45:00.000Z", X),
    run("run.end", "memory.nightly", "2026-11-17T00:50:00.000Z", N),
    // By hand, its router's reply without its cost: unpriced.
    run("run.start", "memory.closeness", "2026-11-18T09:00:00.000Z", C),
    call("2026-11-18T09:01:00.000Z", C, { reads: { memory: 5 } }),
  ] as LogEvent[];
  const unitDays = [
    { date: "2026-11-16", items: 40, source: "whatsapp", units: 4 },
    { date: "2026-11-17", items: 10, source: "whatsapp", units: 2 },
    { date: "2026-11-17", items: 300, source: "lifelog", units: 1 },
  ];
  const days = ["2026-11-16", "2026-11-17", "2026-11-18"];
  const use = sourceUseOf(events, unitDays, [chat, notes, voice], days);
  const of = (s: string) => use.find((u) => u.source === s);
  expect(use.map((u) => u.source)).toEqual([
    "whatsapp",
    "notes",
    "lifelog",
    "memory",
  ]);
  expect(of("whatsapp")).toMatchObject({
    // 40, 10 and a day with none.
    items: { max: 40, median: 10 },
    model: [{ calls: 1, step: "extract (nightly)" }],
    modelFree: ["gather", "CHATS", "SEARCHED", "WITH_PEOPLE", "events"],
    notReported: 0,
    readsPerUnit: 0.5,
    units: { max: 4, median: 2 },
    unitsRead: 3,
  });
  expect(of("whatsapp")?.usdADay).toBeCloseTo(0.1);
  expect(of("whatsapp")?.usdWorstDay).toBeCloseTo(0.3);
  expect(of("whatsapp")?.tokensADay).toBeCloseTo(250);
  expect(of("lifelog")?.usdWorstDay).toBeCloseTo(0.1);
  expect(of("lifelog")?.readsPerUnit).toBe(1);
  // A source with units read by no model call shows its model-free readers alone.
  expect(of("notes")).toMatchObject({
    model: [],
    modelFree: ["gather", "OWN_WRITING", "SEARCHED"],
    readsPerUnit: null,
    unitsRead: 0,
  });
  expect(of("memory")).toMatchObject({
    model: [{ calls: 1, step: "closeness (alone)" }],
    modelFree: [],
    notReported: 1,
    unitsRead: 5,
    usdADay: 0,
  });
  const text = sourceUseText(use, 3);
  expect(text).toContain("model: extract (nightly) ×1");
  expect(text).toContain("Agent turns: not counted here");
  expect(sourceUseLine(use)).toEqual([
    "By source, last 24 h: whatsapp $0.10 (3 units read), lifelog $0.03 (1 units read), memory $0.00 (5 units read, 1 not reported)",
  ]);
});

test("source use: one step's single-source calls of a day are each charged to their own source", () => {
  const events = [
    run("run.start", "memory.exchange-reads", "2026-11-17T00:40:00.000Z", X),
    call("2026-11-17T00:41:00.000Z", X, {
      costUsd: 0.01,
      reads: { whatsapp: 10 },
    }),
    call("2026-11-17T00:42:00.000Z", X, {
      costUsd: 0.5,
      reads: { imessage: 1 },
    }),
    run("run.end", "memory.exchange-reads", "2026-11-17T00:45:00.000Z", X),
  ] as LogEvent[];
  const imessage = {
    ...chat,
    label: "iMessage",
    name: "imessage",
  } as Descriptor;
  const use = sourceUseOf(events, [], [chat, imessage], ["2026-11-17"]);
  expect(use.find((u) => u.source === "whatsapp")?.usdADay).toBeCloseTo(0.01);
  expect(use.find((u) => u.source === "imessage")?.usdADay).toBeCloseTo(0.5);
});
