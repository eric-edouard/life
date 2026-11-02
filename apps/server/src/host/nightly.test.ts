import { expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MACHINE_DIR } from "../core/platform";
import { latestExtractions } from "../memory/ledger";
import { unit } from "../memory/record-fixtures";
import type { Extracted, Observation } from "../records/observation";
import { markedSince, nightly } from "./nightly";

test("each marked unit is listed once read since the last night, with the observations citing its marked lines", () => {
  const u = unit({ marked: ["j:1@a", "j:2@a"] });
  const built = [
    { messages: [], text: "", unit: u },
    { messages: [], text: "", unit: unit({ id: "unit_000000000002" }) },
  ];
  const read = (at: string, id = u.id, unitHash = u.hash) =>
    ({ at, unit: id, unitHash }) as Extracted;
  const latest = (...lines: Extracted[]) => latestExtractions(lines);
  const held = {
    source: { channel: "lifelog", ref: "j:2@a" },
    text: "He will vote for the stones.",
  } as Observation;
  const since = "2026-10-10T02:00:00.000Z";
  const after = latest(
    read("2026-10-10T13:00:00.000Z"),
    read("2026-10-10T13:00:00.000Z", "unit_000000000002")
  );
  expect(
    markedSince(built, after, since, [held]).map((m) => m.relation)
  ).toEqual(["Shop repairs → He will vote for the stones."]);
  expect(markedSince(built, after, since, [])[0]?.relation).toBe(
    "Shop repairs → nothing held"
  );
  // Read before the last night, or since but before the mark changed its content: not listed.
  expect(
    markedSince(
      built,
      latest(read("2026-10-10T13:00:00.000Z", u.id, "unmarked0000000")),
      since,
      [held]
    )
  ).toEqual([]);
  expect(
    markedSince(built, latest(read("2026-10-09T13:00:00.000Z")), since, [held])
  ).toEqual([]);
});

test("while another install's watcher runs on this Mac, a tick does nothing", async () => {
  mkdirSync(MACHINE_DIR, { recursive: true });
  const lock = join(MACHINE_DIR, "watch.lock");
  writeFileSync(lock, `${process.ppid}\n/elsewhere/state`);
  const said = spyOn(console, "log");
  try {
    expect(await nightly(7)).toBe(0);
    expect(said.mock.calls.flat().join(" ")).toContain(
      "another Life runs here"
    );
  } finally {
    said.mockRestore();
    rmSync(lock, { force: true });
  }
});
