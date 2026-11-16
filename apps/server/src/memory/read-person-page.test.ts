import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Unit } from "../records/unit";
import { baseOf, monthsOf } from "../test-data/person-read";
import { buildIndex } from "./index-writer";
import { openWithOf } from "./read-open-items";
import { PART_CHARS } from "./read-part";
import {
  heldLines,
  lastExchangeLine,
  nowLines,
  partLines,
} from "./read-person-page";

const years = [2023, 2024];
const months = monthsOf(years);
const base = baseOf(years);
const MORE_OPEN =
  /\d+ more open with them, ranked lower: `read_matters` with person ana/;
const OBS_DAY = /^- obs (\S+) /;
const OLDER = /^Older: the same call with `before` (\S+)\.$/;
test("`now` with 200 open items still fits the part, and says how many more there are", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({
    at: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
    id: `obs_${String(i).padStart(12, "0")}`,
    kind: "to_do" as const,
    line: `- to do ${i}: ${"he owes them a long errand ".repeat(11)}`,
    people: ["person:ana"],
    person: "person:ana",
    when: "2026-11-14",
  }));
  const nowBlock = nowLines({
    after: ["SITUATION"],
    before: ["TITLES".repeat(100), "DETAILS", "CLOSE", "LAST EXCHANGE"],
    open: (room) =>
      openWithOf("person:ana", {
        goals: [],
        items,
        room,
        today: "2026-11-14",
      }),
  });
  const text = partLines({ ...base, fixed: nowBlock, part: "now" }).join("\n");
  expect(text.length).toBeLessThan(PART_CHARS);
  expect(text).toContain("to do ");
  expect(text).toMatch(MORE_OPEN);
  expect(text).toContain("SITUATION");
  expect(text).toContain("Next reads");
});

test("someone only heard has no parts: `now` is their evidence, paged back with `before`, ending with the older call", () => {
  const heard = { ...base, heard: [{ name: "Zed" }], ref: undefined };
  let before: string | undefined;
  const days = new Set<string>();
  for (let page = 0; page < 200; page += 1) {
    const out = partLines({ ...heard, before, fixed: [], part: "now" });
    expect(out.join("\n")).not.toContain("Next reads");
    expect(out).toContain("HELD 2023-01");
    for (const l of out) {
      const day = OBS_DAY.exec(l)?.[1];
      if (day) {
        expect(days.has(`${day}${l}`)).toBe(false);
        days.add(`${day}${l}`);
      }
    }
    const older = OLDER.exec(out.at(-1) as string);
    if (!older) {
      expect(out.at(-1)).toBe("(nothing older)");
      expect(days.size).toBe(months.length * 3);
      return;
    }
    [, before] = older;
  }
  throw new Error("never ended");
});

test("the last exchange: when, who opened it, how many each sent", () => {
  const row = (start: string, heOpened: boolean, sent: number, got: number) =>
    ({ got, heOpened, sent, start }) as never;
  expect(
    lastExchangeLine({
      rows: [
        row("2024-03-01T10:00:00.000Z", true, 1, 1),
        row("2025-06-02T10:00:00.000Z", false, 4, 2),
      ],
    })
  ).toEqual([
    "Last exchange: 2025-06-02, opened by them; he sent 4, they sent 2.",
  ]);
  expect(lastExchangeLine({ rows: [] })).toEqual([]);
  expect(lastExchangeLine(null)).toEqual([]);
});

test("what Life holds, by year with the sources, or by month inside one year", async () => {
  const dir = await mkdtemp(join(tmpdir(), "life-held-"));
  const path = join(dir, "i.sqlite");
  const unit = (date: string, n: number) =>
    ({
      date,
      id: `unit_00000000000${n}`,
      people: ["person:ana"],
      source: "lifelog",
      title: "t",
    }) as unknown as Unit;
  const units = [
    unit("2025-01-10", 1),
    unit("2025-03-10", 2),
    unit("2026-02-10", 3),
  ];
  buildIndex(
    [],
    path,
    {
      corrections: [],
      latest: new Map(),
      live: new Set(units.map((u) => u.id)),
      retired: new Map(),
    },
    units.map((u) => ({ unit: u }))
  );
  const db = new Database(path, { readonly: true });
  try {
    const sources = heldLines(db, "person:ana", [], { sourcesOnly: true });
    expect(sources.some((l) => l.startsWith("- lifelog: 3 units"))).toBe(true);
    expect(sources.join("\n")).not.toContain("By month");
    const byMonth = heldLines(db, "person:ana", [], { span: "2025" });
    expect(byMonth.filter((l) => l.startsWith("- 2025-")).length).toBe(2);
    expect(byMonth.join("\n")).not.toContain("2026");
    expect(byMonth.join("\n")).not.toContain("What Life holds about them");
    expect(byMonth.join("\n")).not.toContain("Not in Life");
  } finally {
    db.close();
    rmSync(dir, { force: true, recursive: true });
  }
});
