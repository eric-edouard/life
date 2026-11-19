import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openArchive } from "./archived";

test("an archive store waits 5 s for a busy store instead of failing at once", () => {
  const dir = mkdtempSync(join(tmpdir(), "archive-busy-"));
  const db = openArchive(dir, "t", "create table if not exists t (x)");
  expect(db.query("pragma busy_timeout").get()).toEqual({ timeout: 5000 });
  db.close();
});
