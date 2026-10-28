import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openReadOnly } from "./sqlite";

test("a store opened to read waits for a writer and never writes", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-sqlite-")), "s.sqlite");
  new Database(path).run("create table t (x)");
  const db = openReadOnly(path);
  expect(db.query("pragma busy_timeout").get()).toEqual({ timeout: 5000 });
  expect(() => db.run("insert into t values (1)")).toThrow();
});
