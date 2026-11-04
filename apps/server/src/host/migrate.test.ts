import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Moment } from "../records/moment";
import { migrateStored } from "./migrate";

// Made-up moments from before v2: a dinner that happened, a plan, an unsure one.
const old = (id: string, status: string) => ({
  copies: [],
  day: "2026-10-20",
  end: null,
  id,
  importance: 1,
  madeBy: {
    engine: "codex",
    model: "m",
    prompt: "memory-moments.v5",
    run: "r",
  },
  people: [],
  place: null,
  schemaVersion: 1,
  start: "2026-10-20 20:00",
  status,
  title: "Dinner",
  units: ["unit_000000000001"],
  why: "They ate at Chez Paul.",
});

test("moments become what happened: plans and unsure ones go, `why` becomes `what`, `within` null; run twice, nothing changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-migrate-"));
  mkdirSync(join(dir, "memory", "moments"), { recursive: true });
  const day = join(dir, "memory", "moments", "2026-10-20.jsonl");
  writeFileSync(
    day,
    [
      old("mom_000000000001", "happened"),
      old("mom_000000000002", "planned"),
      old("mom_000000000003", "unsure"),
    ]
      .map((m) => `${JSON.stringify(m)}\n`)
      .join("")
  );
  await migrateStored(dir);
  const after = readFileSync(day, "utf8");
  const lines = after
    .trim()
    .split("\n")
    .map((l) => Moment.parse(JSON.parse(l)));
  expect(lines.map((m) => [m.id, m.what, m.within])).toEqual([
    ["mom_000000000001", "They ate at Chez Paul.", null],
  ]);
  await migrateStored(dir);
  expect(readFileSync(day, "utf8")).toBe(after);
  expect(
    readFileSync(join(dir, "memory", "migrations.jsonl"), "utf8")
  ).toContain('"name":"moments-v2-2026-11"');
});
