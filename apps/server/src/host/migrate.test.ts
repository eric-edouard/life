import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateStored } from "./migrate";

test("zone runs on a fixed offset are tagged mail in place; the others and the order stay; run twice, nothing changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-migrate-"));
  mkdirSync(join(dir, "memory"));
  const zones = join(dir, "memory", "zones.jsonl");
  const line = (from: string, tz: string) =>
    `${JSON.stringify({ from, schemaVersion: 1, tz })}\n`;
  writeFileSync(
    zones,
    line("2025-06-01T00:00:00.000Z", "Europe/Paris") +
      line("2019-01-05T17:00:00.000Z", "Etc/GMT-7") +
      line("2019-01-09T00:00:00.000Z", "Etc/GMT")
  );
  await migrateStored(dir);
  const after = readFileSync(zones, "utf8");
  expect(after).toBe(
    line("2025-06-01T00:00:00.000Z", "Europe/Paris") +
      `${JSON.stringify({ from: "2019-01-05T17:00:00.000Z", schemaVersion: 1, source: "mail", tz: "Etc/GMT-7" })}\n` +
      `${JSON.stringify({ from: "2019-01-09T00:00:00.000Z", schemaVersion: 1, source: "mail", tz: "Etc/GMT" })}\n`
  );
  await migrateStored(dir);
  expect(readFileSync(zones, "utf8")).toBe(after);
});
