import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DAY, MIN } from "../core/clock";
import { EMBEDDER_MODEL, textHashOf } from "../core/embedder";
import { setSettings, settings } from "../core/settings";
import type { Episode } from "../records/episode";
import { episodeTextNow, UNIT_TEXT } from "./index-rows";
import { buildIndex, readSearchedTexts, readStaleness } from "./index-writer";
import { INDEX, MEMORY, UNITS } from "./memory-files";
import { TRUTH } from "./read-truth";
import { madeBy, unit, verdict } from "./record-fixtures";

test("the index is stale when memory/ (units/ aside) or truth/ changed after its reads began; truth/ says so", async () => {
  const path = join(await mkdtemp(join(tmpdir(), "life-stale-")), "i.sqlite");
  expect(readStaleness(path)).toBe("index");
  const statusInputs = {
    corrections: [],
    latest: new Map(),
    live: new Set<string>(),
    retired: new Map(),
  };
  const later = new Date(Date.now() + DAY);
  buildIndex([], path, statusInputs, [], later);
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

test("stored search hashes keep the exact ranked text and pre-hash indexes rebuild", async () => {
  const path = join(
    await mkdtemp(join(tmpdir(), "life-hashes-")),
    "index.sqlite"
  );
  const u = unit({ summary: "A repair quotation" });
  const v = verdict(u, { topics: ["repairs", "budget"] });
  buildIndex(
    [],
    path,
    {
      corrections: [],
      latest: new Map(),
      live: new Set([u.id]),
      retired: new Map(),
    },
    [{ unit: u, verdict: v }],
    new Date("2099-01-01")
  );
  const db = new Database(path);
  const row = db
    .query<{ hash: string; text: string }, []>(
      `select h.hash, ${UNIT_TEXT} as text from unit_search s join search_hashes h on h.id=s.id`
    )
    .get();
  expect(row?.hash).toBe(textHashOf(EMBEDDER_MODEL, row?.text ?? ""));
  expect(row?.text).toBe("Shop repairs\nA repair quotation\nrepairs budget");
  expect(readStaleness(path)).toBeNull();
  db.run("drop table episode_search");
  expect(readStaleness(path)).toBe("index");
  db.run("drop table search_hashes");
  expect(readStaleness(path)).toBe("index");
  db.close();
});

test("embedding reads indexed episode text and unit hashes through read-only stores", () => {
  mkdirSync(dirname(INDEX), { recursive: true });
  const u = unit();
  const episode: Episode = {
    copies: [],
    day: u.date,
    end: null,
    id: "episode_000000000001",
    importance: 2,
    madeBy,
    people: [],
    place: null,
    schemaVersion: 1,
    start: null,
    title: "Repair visit",
    units: [u.id],
    what: "Discussed a repair.",
    within: null,
  };
  buildIndex(
    [],
    INDEX,
    { corrections: [], latest: new Map(), live: new Set(), retired: new Map() },
    [{ unit: u }],
    new Date("2099-01-01"),
    [episode]
  );
  const before = settings().sources;
  setSettings({ sources: [] });
  const db = new Database(":memory:");
  try {
    readSearchedTexts(db);
    const texts = db
      .query<{ text: string; hash: string }, []>(
        "select text, hash from searched"
      )
      .all();
    expect(texts).toContainEqual({
      hash: textHashOf(EMBEDDER_MODEL, episodeTextNow(episode)),
      text: episodeTextNow(episode),
    });
    expect(texts).toHaveLength(2);
    expect(() => db.run("delete from search_index.episode_search")).toThrow(
      "readonly"
    );
  } finally {
    db.close();
    setSettings({ sources: before });
  }
});
