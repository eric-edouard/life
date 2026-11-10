import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { iso, MIN } from "../core/clock";
import type { SourceEvent } from "../records/source";
import { buildIndex } from "./index-writer";
import {
  passagesOf,
  preparePassages,
  readPassageCandidates,
  readPassages,
  writePassages,
} from "./passages";
import { dayUnitId } from "./units";
import { dayStart } from "./zones";

const pathOf = () =>
  join(mkdtempSync(join(tmpdir(), "life-passages-")), "passages.sqlite");
const messages = (boundary: string) =>
  Array.from(
    { length: 30 },
    (_, i): SourceEvent => ({
      at: iso(dayStart(boundary).getTime() + (i - 20) * MIN),
      chat: "room",
      fromMe: true,
      id: `m${i}`,
      sender: "owner",
      source: "line",
      text: `Message ${i}`,
    })
  );
const readerOf = (events: SourceEvent[]) => (from: Date, to?: Date) =>
  events.filter(
    (e) => e.at >= from.toISOString() && (!to || e.at < to.toISOString())
  );

for (const [before, after] of [
  ["2020-04-14", "2020-04-15"],
  ["2020-04-30", "2020-05-01"],
]) {
  test(`one passage owner and stable size cuts across ${after}`, () => {
    const all = messages(after as string);
    const path = pathOf();
    const read = readerOf(all);
    // Start on the later day: the preceding run must still anchor its 12-message phase.
    writePassages(
      read(dayStart(after as string), dayStart("2020-05-02")),
      { from: after as string, to: after as string },
      [],
      { line: read },
      path
    );
    writePassages(
      read(dayStart(before as string), dayStart(after as string)),
      { from: before as string, to: before as string },
      [],
      { line: read },
      path
    );
    writePassages(
      read(dayStart(after as string), dayStart("2020-05-02")),
      { from: after as string, to: after as string },
      [],
      { line: read },
      path
    );
    const rows = readPassages({}, false, path).sort((a, b) =>
      a.start.localeCompare(b.start)
    );
    expect(rows.map((p) => p.events.map((e) => e.id))).toEqual(
      passagesOf(all).map((p) => p.map((e) => e.id))
    );
    expect(new Set(rows.flatMap((p) => p.events.map((e) => e.id))).size).toBe(
      30
    );
    expect(
      rows.every((p) => p.unit === dayUnitId(p.events[0] as SourceEvent))
    ).toBe(true);
    expect(rows.map((p) => p.events.length)).toEqual([12, 12, 6]);
  });
}

test("retry refreshes a former cross-midnight edge, including a deleted outside-window message", () => {
  const path = pathOf();
  const all = messages("2020-05-01");
  const write = (events: SourceEvent[]) =>
    writePassages(
      readerOf(events)(dayStart("2020-05-01")),
      { from: "2020-05-01", to: "2020-05-01" },
      [],
      { line: readerOf(events) },
      path
    );
  write(all);
  const changed = all.filter((e) => e.id !== "m19");
  write(changed);
  const rows = readPassages({}, false, path).sort((a, b) =>
    a.start.localeCompare(b.start)
  );
  expect(rows.map((p) => p.events.map((e) => e.id))).toEqual(
    passagesOf(changed).map((p) => p.map((e) => e.id))
  );
});

test("failed boundary read publishes nothing; empty retry removes its old rows", () => {
  const path = pathOf();
  const all = messages("2020-05-01");
  const window = { from: "2020-05-01", to: "2020-05-01" };
  expect(() =>
    preparePassages(
      all,
      window,
      [],
      {
        line: () => {
          throw new Error("unreadable");
        },
      },
      path
    )
  ).toThrow("unreadable");
  expect(readPassages({}, false, path)).toEqual([]);
  writePassages(all, window, [], { line: readerOf(all) }, path);
  writePassages([], window, [], { line: () => [] }, path);
  expect(readPassages({}, false, path)).toEqual([]);
});

test("a metadata index rebuild cannot erase passages; word/date candidates use stored hashes", () => {
  const path = pathOf();
  const all = messages("2020-05-01");
  writePassages(
    all,
    { from: "2020-04-30", to: "2020-05-01" },
    [],
    { line: readerOf(all) },
    path
  );
  const index = join(
    mkdtempSync(join(tmpdir(), "life-index-")),
    "index.sqlite"
  );
  buildIndex([], index, {
    corrections: [],
    latest: new Map(),
    live: new Set(),
    retired: new Map(),
  });
  const found = readPassageCandidates("message 29", {}, false, path, true);
  expect(found.count).toBe(1);
  expect(found.hashes.every((p) => p.hash.length === 64)).toBe(true);
  expect(
    readPassages({}, false, path, found.held)
      .flatMap((p) => p.events)
      .at(-1)?.id
  ).toBe("m29");
  expect(
    readPassageCandidates("message", { from: "2021-01-01" }, false, path).count
  ).toBe(0);
});

test("a natural run touching a deferred zone day is deferred whole across midnight", () => {
  const path = pathOf();
  const all = messages("2020-05-01");
  const read = readerOf(all);
  writePassages(
    read(dayStart("2020-05-01")),
    { from: "2020-05-01", to: "2020-05-01" },
    [],
    { line: read },
    path,
    new Set(["2020-04-30"])
  );
  expect(readPassages({}, false, path)).toEqual([]);
});

test("edge storage reads are shared across chats and skipped when the closest event is far from midnight", () => {
  const path = pathOf();
  const all = Array.from({ length: 100 }, (_, i) =>
    messages("2020-05-01").map((e) => ({
      ...e,
      chat: `room${i}`,
      id: `${i}:${e.id}`,
    }))
  ).flat();
  let reads = 0;
  const read = (from: Date, to?: Date) => {
    reads += 1;
    return readerOf(all)(from, to);
  };
  writePassages(
    readerOf(all)(dayStart("2020-05-01")),
    { from: "2020-05-01", to: "2020-05-01" },
    [],
    { line: read },
    path
  );
  expect(reads).toBe(1);
  reads = 0;
  const middle = [
    {
      ...(all[0] as SourceEvent),
      at: iso(dayStart("2020-05-03").getTime() + 12 * 60 * MIN),
    },
  ];
  writePassages(
    middle,
    { from: "2020-05-03", to: "2020-05-03" },
    [],
    { line: read },
    path
  );
  expect(reads).toBe(0);
});
