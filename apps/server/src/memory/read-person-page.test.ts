import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Unit } from "../records/unit";
import { baseOf, monthsOf } from "../test-data/person-read";
import { buildIndex } from "./index-writer";
import { heardEvidence, heldLines } from "./read-person-page";

const years = [2023, 2024];
const months = monthsOf(years);
const base = baseOf(years);
const OBS_DAY = /^- obs (\S+) /;
test("someone only heard has no parts: their read is their evidence as data, paged back with `nextBefore` until none is older", () => {
  const heard = {
    ...base,
    heard: [{ name: "Zed" }, { name: "Zed" }],
    ref: undefined,
  };
  let before: string | undefined;
  const days = new Set<string>();
  for (let page = 0; page < 200; page += 1) {
    const out = heardEvidence({ ...heard, before, fixed: [], part: "now" });
    expect(out.heard).toEqual([{ name: "Zed" }]);
    expect(out.evidence).toContain("HELD 2023-01");
    for (const l of out.evidence) {
      const day = OBS_DAY.exec(l)?.[1];
      if (day) {
        expect(days.has(`${day}${l}`)).toBe(false);
        days.add(`${day}${l}`);
      }
    }
    if (!out.nextBefore) {
      expect(days.size).toBe(months.length * 3);
      return;
    }
    before = out.nextBefore;
  }
  throw new Error("never ended");
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
      stats: { chars: 0, fromMe: 0, items: 1 },
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
      live: new Set(units.map((u) => u.id)),
      retired: new Map(),
      standing: new Map(),
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
