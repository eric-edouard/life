import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observationId } from "../memory/observe";
import { lineHash } from "../memory/page-format";
import { migrateStored, needsRename, renameStored } from "./migrate";

// Made-up memory as it was written before the rename: a decision and a to-do, cited across the files.
const unit = "unit_0123456789ab";
const quote = "we take the blue tiles";
const text = "The owner chose the blue tiles";
const was = observationId(unit, "decision", quote, text);
const now = observationId(unit, "choice", quote, text);
const todo = observationId(unit, "to_do", "buy grout", "Buy grout");
const pageLine = `- The owner chose the blue tiles [${was}]`;
const files = () =>
  new Map([
    [
      "memory/observations/2026-10.jsonl",
      [
        { id: was, quote, text, type: "decision", unit },
        {
          id: todo,
          quote: "buy grout",
          text: "Buy grout",
          type: "to_do",
          unit,
        },
      ]
        .map((o) => JSON.stringify(o))
        .join("\n"),
    ],
    ["memory/ratings.jsonl", JSON.stringify({ ref: was, why: `about ${was}` })],
    [
      "memory/statements.jsonl",
      JSON.stringify({ ref: was, text: `a decision, ${was} in his words` }),
    ],
    ["memory/labels.jsonl", JSON.stringify({ type: "decision", unit })],
    [
      "memory/pages/areas/house.md",
      [
        "---",
        `lines: ${JSON.stringify({ [lineHash(pageLine)]: [was] })}`,
        "---",
        pageLine,
      ].join("\n"),
    ],
    [
      "docs/evals/cases/tiles.json",
      JSON.stringify({ expected: [was], quote: was }),
    ],
  ]);

test("a decision becomes a choice, its id minted again everywhere it is cited; words, quotes and other types stay", () => {
  const { files: out } = renameStored(files());
  const obs = (out.get("memory/observations/2026-10.jsonl") ?? "")
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(obs[0]).toMatchObject({ id: now, type: "choice" });
  expect(obs[1]).toMatchObject({ id: todo, type: "to_do" });
  expect(JSON.parse(out.get("memory/ratings.jsonl") ?? "")).toEqual({
    ref: now,
    why: `about ${now}`,
  });
  // A statement's text is his words: its ref follows, its text does not.
  expect(JSON.parse(out.get("memory/statements.jsonl") ?? "")).toEqual({
    ref: now,
    text: `a decision, ${was} in his words`,
  });
  expect(JSON.parse(out.get("memory/labels.jsonl") ?? "").type).toBe("choice");
  const page = (out.get("memory/pages/areas/house.md") ?? "").split("\n");
  const moved = pageLine.replace(was, now);
  expect(page[3]).toBe(moved);
  expect(page[1]).toBe(
    `lines: ${JSON.stringify({ [lineHash(moved)]: [now] })}`
  );
  // A case's quote keeps its words.
  expect(JSON.parse(out.get("docs/evals/cases/tiles.json") ?? "")).toEqual({
    expected: [now],
    quote: was,
  });
  // Renamed once, nothing is left to rename.
  const again = new Map([...files(), ...out]);
  expect(renameStored(again).files.size).toBe(0);
});

test("on a copy: the rename swaps memory in whole, writes its line once and runs once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-migrate-"));
  for (const [p, t] of files()) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), `${t}\n`);
  }
  expect(needsRename(dir)).toBe(true);
  await migrateStored(dir);
  expect(needsRename(dir)).toBe(false);
  expect(existsSync(join(dir, "memory.old"))).toBe(false);
  expect(
    readFileSync(join(dir, "memory/observations/2026-10.jsonl"), "utf8")
  ).toContain(now);
  expect(
    readFileSync(join(dir, "docs/evals/cases/tiles.json"), "utf8")
  ).toContain(now);
  const done = () =>
    readFileSync(join(dir, "memory/migrations.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
  expect(done()).toHaveLength(1);
  await migrateStored(dir);
  expect(done()).toHaveLength(1);
});

test("a line written to the old memory during the swap is carried over once, renamed, and the old copy goes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-migrate-"));
  for (const [p, t] of files()) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), `${t}\n`);
  }
  const before = join(dir, "before");
  cpSync(join(dir, "memory"), before, { recursive: true });
  await migrateStored(dir);
  // As if the app died after the swap: the old copy is back, with a rating written into it meanwhile.
  cpSync(before, join(dir, "memory.old"), { recursive: true });
  writeFileSync(
    join(dir, "memory.old/ratings.jsonl"),
    `${JSON.stringify({ ref: was, why: `about ${was}` })}\n${JSON.stringify({ ref: was, why: "late" })}\n`
  );
  const ratings = () =>
    readFileSync(join(dir, "memory/ratings.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
  await migrateStored(dir);
  expect(existsSync(join(dir, "memory.old"))).toBe(false);
  expect(ratings()).toEqual([
    JSON.stringify({ ref: now, why: `about ${now}` }),
    JSON.stringify({ ref: now, why: "late" }),
  ]);
  await migrateStored(dir);
  expect(ratings()).toHaveLength(2);
});
