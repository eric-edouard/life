import { afterEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import type { Unit } from "../records/unit";
import { buildIndex } from "./index-writer";
import { INDEX } from "./memory-files";
import { chatUnitsFor, readPersonUnits } from "./person-units";
import { unit as unitFixture } from "./record-fixtures";

// Made-up people and chats only.

afterEach(() => rmSync(INDEX, { force: true }));

const indexed = (units: Unit[]) => {
  mkdirSync(dirname(INDEX), { recursive: true });
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
};

const u = (n: number, date: string, source: Unit["source"], people: string[]) =>
  unitFixture({
    date,
    id: `unit_${String(n).padStart(12, "0")}`,
    people,
    source,
  });

test("a person's units: newest first, whole days, of the kinds asked, before a day; one query of the index", () => {
  indexed([
    u(1, "2026-11-03", "whatsapp", ["person:ana"]),
    u(2, "2026-11-03", "imessage", ["person:ana", "person:me"]),
    u(3, "2026-11-02", "mail", ["person:ana"]),
    u(4, "2026-11-01", "whatsapp", ["person:ana"]),
    u(5, "2026-11-01", "lifelog", ["person:ana"]),
    u(6, "2026-11-04", "whatsapp", ["person:bo"]),
  ]);
  const ids = (o: Parameters<typeof readPersonUnits>[1]) =>
    readPersonUnits(["person:ana"], o).map((x) => x.id.slice(-1));
  // One unit asked, its whole day given.
  expect(ids({ count: 1, kinds: ["chat"] })).toEqual(["1", "2"]);
  expect(ids({ count: 3, kinds: ["chat", "mail", "voice"] })).toEqual([
    "1",
    "2",
    "3",
  ]);
  expect(
    ids({ before: "2026-11-03", count: 10, kinds: ["chat", "voice"] })
  ).toEqual(["4", "5"]);
  expect(
    readPersonUnits(["person:ana"], { count: 1, kinds: ["mail"] })
  ).toEqual([
    {
      date: "2026-11-02",
      id: "unit_000000000003",
      people: ["person:ana"],
      source: "mail",
    },
  ]);
});

test("the chat-days tried are 1:1 chats with the check's person, newest first, three at most", () => {
  const u = (id: string, date: string, people: string[], source = "whatsapp") =>
    ({ date, id, people, source }) as Parameters<
      typeof chatUnitsFor
    >[0][number];
  const units = [
    u("unit_a", "2026-11-01", ["person:me", "person:inf_kit"]),
    u("unit_b", "2026-11-03", ["unknown:+33600000001"]),
    // A group's day: someone else wrote too.
    u("unit_c", "2026-11-04", ["person:inf_kit", "person:zoe"]),
    // Mail is no network's chat.
    u("unit_d", "2026-11-05", ["person:inf_kit"], "mail"),
    // Another person's chat, even one the guess's evidence cites, is not theirs.
    u("unit_e", "2026-10-01", ["unknown:+33600000009"]),
    u("unit_f", "2026-09-01", ["person:inf_kit"]),
    u("unit_g", "2026-08-01", ["person:inf_kit"]),
  ];
  const refs = new Set(["person:inf_kit", "unknown:+33600000001"]);
  expect(chatUnitsFor(units, refs).map((x) => x.id)).toEqual([
    "unit_b",
    "unit_a",
    "unit_f",
  ]);
});
