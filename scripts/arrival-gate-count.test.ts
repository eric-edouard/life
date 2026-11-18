import { expect, test } from "bun:test";
import { HOUR, MIN } from "@life/server/src/core/clock";
import type { SourceEvent } from "@life/server/src/records/source";
import {
  arrivalsOf,
  burstsOf,
  missesOf,
  passesOn,
  replay,
} from "./arrival-gate-count";

const START = Date.parse("2026-11-10T10:00:00.000Z");
const SAM = "33600000001@s.whatsapp.net";
const at = (minutes: number) => new Date(START + minutes * MIN).toISOString();
const msg = (
  minutes: number,
  over: Partial<SourceEvent> = {}
): SourceEvent => ({
  at: at(minutes),
  chat: SAM,
  fromMe: false,
  id: `whatsapp:${minutes}`,
  sender: SAM,
  source: "whatsapp",
  text: "Can you send me the transcript?",
  ...over,
});

test("bursts: a new one after 2 minutes of quiet or 10 minutes after the burst began", () => {
  const lines = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 20].map((m) => ({
    at: m * MIN,
    id: `${m}`,
  }));
  expect(burstsOf(lines).map((b) => b.length)).toEqual([10, 2, 1]);
});

test("replay: one pass at a time; what arrives during a pass waits for the next; a stranger is held, and the asks say what was missed", () => {
  const stranger = "33600000002@s.whatsapp.net";
  const events = [
    msg(5),
    msg(9, { id: "whatsapp:9b" }),
    msg(30, { chat: stranger, id: "whatsapp:x", sender: stranger }),
  ];
  const r = replay({
    end: START + 2 * HOUR,
    events,
    ownerNames: ["Alex"],
    resolve: (h) => (h === SAM ? "person:sam" : null),
    start: START,
    talks: [],
  });
  // Due at 10:08 (quiet for 2 minutes), then again after the pass that started then, for the line at 10:09.
  expect(r.passes.map((p) => p.at)).toEqual([
    START + 8 * MIN,
    START + 18 * MIN,
  ]);
  const atOf = new Map(events.map((e) => [e.id, Date.parse(e.at)]));
  const { held, rows } = arrivalsOf(r, atOf);
  expect(
    [...rows.values()].map((x) => [x.arrivals, x.passed, x.passes.size])
  ).toEqual([[3, 2, 2]]);
  expect(Object.fromEntries(held)).toEqual({ stranger: 1 });
  const truth = {
    asks: [
      {
        channel: "whatsapp",
        ref: "whatsapp:5",
        unit: r.passes[0]?.units[0] ?? "",
      },
      { channel: "whatsapp", ref: "whatsapp:x", unit: "unit_x" },
    ],
    kept: new Set<string>(),
  };
  expect(Object.fromEntries(missesOf(r, truth, atOf))).toEqual({
    "whatsapp missed: stranger": 1,
    "whatsapp read by day": 1,
  });
  expect(passesOn("2026-11-10", r, truth)).toMatchObject({
    full: 2,
    passes: 2,
  });
});
