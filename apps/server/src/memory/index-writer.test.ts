import { expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DAY, MIN } from "../core/clock";
import { buildIndex, readStaleness } from "./index-writer";
import { MEMORY, UNITS } from "./ledger";
import { TRUTH } from "./read-truth";

test("the index is stale when memory/ (units/ aside) or truth/ changed after its reads began; truth/ says so", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "life-stale-")), "i.sqlite");
  expect(readStaleness(path)).toBe("index");
  const standing = {
    corrections: [],
    latest: new Map(),
    live: new Set<string>(),
    retired: new Map(),
  };
  const later = new Date(Date.now() + DAY);
  buildIndex([], path, standing, [], later);
  expect(readStaleness(path)).toBeNull();
  const touch = (file: string) => {
    const at = new Date(later.getTime() + MIN);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "");
    utimesSync(file, at, at);
  };
  const unitFile = join(UNITS, "2026-10-20.jsonl");
  const correction = join(MEMORY, "stale-test.jsonl");
  const edit = join(TRUTH, "stale-test.md");
  try {
    touch(unitFile);
    expect(readStaleness(path)).toBeNull();
    touch(correction);
    expect(readStaleness(path)).toBe("index");
    touch(edit);
    expect(readStaleness(path)).toBe("truth");
  } finally {
    rmSync(UNITS, { force: true, recursive: true });
    rmSync(correction, { force: true });
    rmSync(edit, { force: true });
  }
});
