import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY } from "../core/clock";
import {
  PHOTO_DESCRIPTION_PROMPT,
  readDescriptions,
  readHandled,
  writeDescriptions,
} from "./photo-descriptions";

const store = () =>
  join(mkdtempSync(join(tmpdir(), "descriptions-")), "store.sqlite");
const row = (uuid: string, over = {}) => ({
  model: "made-up",
  outcome: "described" as const,
  text: "A beach at dusk.",
  uuid,
  ...over,
});

test("a store not made yet reads as empty", () => {
  const path = store();
  expect(readDescriptions(["A"], path).size).toBe(0);
  expect(readHandled(path).size).toBe(0);
});

test("a described photo is never written over; a failed one or one with no image is, by the next try", () => {
  const path = store();
  writeDescriptions(
    [
      row("A"),
      row("B", { error: "timed out", outcome: "failed", text: undefined }),
      row("C", { outcome: "no-image", text: undefined }),
    ],
    path
  );
  writeDescriptions(
    [
      row("A", { text: "Another reading." }),
      row("B"),
      row("C", { text: "A tree." }),
    ],
    path
  );
  expect(readDescriptions(["A", "B", "C", "D"], path)).toEqual(
    new Map([
      ["A", "A beach at dusk."],
      ["B", "A beach at dusk."],
      ["C", "A tree."],
    ])
  );
});

test("a photo is settled when described, failed less than a day ago, or without an image less than a week ago", () => {
  const path = store();
  writeDescriptions(
    [
      row("done"),
      row("fresh", { outcome: "failed", text: undefined }),
      row("old", { outcome: "failed", text: undefined }),
      row("none", { outcome: "no-image", text: undefined }),
      row("none-old", { outcome: "no-image", text: undefined }),
    ],
    path
  );
  const db = new Database(path);
  db.run(
    "update descriptions set at = '2020-01-01T00:00:00.000Z' where uuid in ('old', 'none-old')"
  );
  db.run(
    `update descriptions set at = '${new Date(clock().getTime() - 3 * DAY).toISOString()}' where uuid in ('none')`
  );
  db.close();
  expect(readHandled(path)).toEqual(new Set(["done", "fresh", "none"]));
});

test("rows of another prompt are not read", () => {
  const path = store();
  writeDescriptions([row("A")], path);
  const db = new Database(path);
  db.run(`update descriptions set prompt = '${PHOTO_DESCRIPTION_PROMPT}.old'`);
  db.close();
  expect(readDescriptions(["A"], path).size).toBe(0);
});
