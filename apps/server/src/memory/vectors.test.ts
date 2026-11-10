import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  bytesOf,
  EMBEDDER_MODEL,
  embedderAt,
  nearest,
  textHashOf,
  vectorOf,
} from "../core/embedder";
import { VECTORS } from "./ledger";
import { embedNew, embedQuery, pruneVectors, readNearest } from "./vectors";

beforeEach(() => {
  rmSync(VECTORS, { force: true });
});

test("with no embedder, or one down, search says it ranks by words alone", async () => {
  expect(await embedQuery("window", null)).toEqual({
    note: "(by words only: no voice source, so no embedder)",
  });
  expect(
    (await embedQuery("window", embedderAt("http://127.0.0.1:1"))).note
  ).toStartWith("(by words only: the embedder is down");
});

test("embedding caps a tick at 256 missing texts and reselects newest arrivals", async () => {
  const texts = Array.from({ length: 300 }, (_, i) => ({
    at: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
    text: `old text ${i}`,
  }));
  const asked: string[] = [];
  const embedder = {
    embed: (part: string[]) => {
      asked.push(...part);
      return Promise.resolve(part.map(() => [3, 4]));
    },
    model: EMBEDDER_MODEL,
  };
  expect(await embedNew(embedder, texts)).toBe(256);
  expect(asked[0]).toBe("old text 299");
  expect(asked).not.toContain("old text 0");
  asked.length = 0;
  expect(
    await embedNew(embedder, [
      ...texts,
      { at: "2026-02-01", text: "new arrival" },
    ])
  ).toBe(45);
  expect(asked[0]).toBe("new arrival");
  expect(
    readNearest([3, 4], () => [
      { hash: textHashOf(EMBEDDER_MODEL, "old text 0"), id: "old" },
    ])
  ).toEqual(["old"]);
  const db = new Database(VECTORS);
  const row = db
    .query<{ vector: Uint8Array; partition: number }, []>(
      "select vector, partition from vectors limit 1"
    )
    .get();
  expect([...vectorOf(row?.vector ?? new Uint8Array())]).toEqual([
    Math.fround(0.6),
    Math.fround(0.8),
  ]);
  expect(row?.partition).toBe(0);
  db.close();
});

test("failed embeddings publish no rows and can resume with the same hash", async () => {
  const texts = [{ at: "2026-01-01", text: "retry this" }];
  await expect(
    embedNew(
      {
        embed: () => Promise.reject(new Error("refused")),
        model: EMBEDDER_MODEL,
      },
      texts
    )
  ).rejects.toThrow("refused");
  expect(readNearest([1, 0], () => [{ id: "x", text: "retry this" }])).toEqual(
    []
  );
  expect(
    await embedNew(
      { embed: () => Promise.resolve([[2, 0]]), model: EMBEDDER_MODEL },
      texts
    )
  ).toBe(1);
});

test("legacy vectors retain hashes through normalized partition conversion and pruning", async () => {
  mkdirSync(dirname(VECTORS), { recursive: true });
  const db = new Database(VECTORS);
  db.run("create table vectors (hash text primary key, vector blob not null)");
  const insert = db.prepare("insert into vectors values (?, ?)");
  db.transaction(() => {
    for (let i = 0; i < 4100; i += 1) {
      insert.run(textHashOf(EMBEDDER_MODEL, `text ${i}`), bytesOf([3, 4]));
    }
  })();
  db.close();
  const items = [
    { id: "a", text: "text 0" },
    { id: "b", text: "text 4099" },
  ];
  expect(readNearest([3, 4], () => items)).toEqual(["a", "b"]);
  await embedNew(
    { embed: () => Promise.resolve([[1, 0]]), model: EMBEDDER_MODEL },
    [{ at: "2026-01-01", text: "added" }]
  );
  const reshaped = new Database(VECTORS);
  expect(
    reshaped
      .query<{ n: number }, []>(
        "select count(*) n from vectors where partition = 1"
      )
      .get()?.n
  ).toBe(5);
  reshaped.close();
  expect(readNearest([3, 4], () => items)).toEqual(["a", "b"]);
  pruneVectors({ embed: () => Promise.resolve([]), model: EMBEDDER_MODEL }, [
    { at: "2026-01-01", text: "text 4099" },
  ]);
  expect(readNearest([3, 4], () => items)).toEqual(["b"]);
});

test("nearest merges only bounded top scores across partitions and preserves the threshold", () => {
  const items = Array.from(
    { length: 9000 },
    (_, i) => [String(i), new Float32Array([i + 1, 9000 - i])] as const
  );
  const wanted = items
    .map(([id, v]) => [id, (v[0] ?? 0) / Math.hypot(...v)] as const)
    .filter(([, score]) => score >= 0.25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 200)
    .map(([id]) => id);
  expect(nearest([1, 0], items)).toEqual(wanted);
  expect(nearest([1, 0], [["opposite", new Float32Array([-1, 0])]])).toEqual(
    []
  );
});
