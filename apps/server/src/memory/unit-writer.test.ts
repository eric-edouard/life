import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { Unit } from "../records/unit";
import { readUnits, UNITS } from "./ledger";
import {
  diffUnits,
  keptToday,
  publishTodayUnits,
  writeUnits,
} from "./unit-writer";

/** The sources of the units in memory/units/, by day. */
const sourcesByDay = async () =>
  Object.fromEntries(
    Map.groupBy(await readUnits(), (u) => u.date)
      .entries()
      .map(([d, us]) => [d, us.map((u) => u.source)])
  );

test("today's sync writes its own sources' units, keeps lifelog's and a failed source's, and says when one went", async () => {
  expect(existsSync(UNITS)).toBe(false); // test data has no units: this test makes and removes them
  const day = "2026-10-25";
  const unit = (id: string, source: Unit["source"], title = "Team"): Unit => ({
    date: day,
    end: `${day}T09:00:00.000Z`,
    hash: "0123456789abcdef",
    id,
    key: `${id}@g.us`,
    people: [],
    refs: [`${source}:${id}`],
    schemaVersion: 1,
    source,
    start: `${day}T09:00:00.000Z`,
    stats: { chars: 40, fromMe: 1, items: 1 },
    title,
  });
  const voice = unit("unit_00000000000a", "lifelog");
  const chat = unit("unit_00000000000b", "whatsapp");
  const mail = unit("unit_00000000000c", "mail");
  let published = 0;
  const built = (want: Unit[], failed: string[] = []) => ({
    day,
    kept: keptToday(["whatsapp", "mail"], failed),
    passages: () => {
      published += 1;
    },
    want,
  });
  try {
    await writeUnits([day], [voice, mail]);
    expect(await publishTodayUnits(built([chat], ["mail"]))).toMatchObject({
      added: 1,
      hasGoneOrBack: false,
      removed: 0,
    });
    expect(await sourcesByDay()).toEqual({
      [day]: ["lifelog", "whatsapp", "mail"],
    });
    // Nothing new: nothing written, no passages, nothing to index.
    expect((await publishTodayUnits(built([chat], ["mail"]))).written).toEqual(
      []
    );
    expect(published).toBe(1);
    // A chat-day whose every message was unsent: its unit goes, and the index is rebuilt whole.
    expect(await publishTodayUnits(built([], ["mail"]))).toMatchObject({
      hasGoneOrBack: true,
      removed: 1,
    });
    expect(await sourcesByDay()).toEqual({ [day]: ["lifelog", "mail"] });
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
  }
});

test("a unit dropped or taken back by a code rule counts as gone or back", () => {
  const u = {
    date: "2026-10-25",
    end: "2026-10-25T09:00:00.000Z",
    hash: "0123456789abcdef",
    id: "unit_00000000000d",
    key: "k",
    people: [],
    refs: ["whatsapp:k"],
    schemaVersion: 1,
    source: "whatsapp",
    start: "2026-10-25T09:00:00.000Z",
    stats: { chars: 1, fromMe: 1, items: 1 },
    title: "T",
  } as Unit;
  const dropped = { ...u, drop: "duplicate" } as Unit;
  expect(diffUnits([u], [dropped]).hasGoneOrBack).toBe(true);
  expect(diffUnits([dropped], [u]).hasGoneOrBack).toBe(true);
  expect(diffUnits([u], [u])).toMatchObject({
    dates: [],
    hasGoneOrBack: false,
  });
});
