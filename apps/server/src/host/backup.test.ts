import { expect, test } from "bun:test";
import { HOUR } from "../core/clock";
import { backupLine } from "./backup";

test("the backup line is flagged when the last run went wrong or the last snapshot is over 48 h old", () => {
  const okAt = "2026-10-15T03:00:00.000Z";
  const s = { bytes: 5_500_000_000, okAt, snapshot: "abcd1234" };
  const hours = (h: number) => new Date(Date.parse(okAt) + h * HOUR);
  expect(backupLine(hours(20), s)).toEndWith(", 5.5 GB");
  expect(backupLine(hours(49), s)).toEndWith(" · OVER 48 H OLD");
  expect(backupLine(hours(1), { ...s, error: "cp: no cursor" })).toEndWith(
    ", 5.5 GB · cp: no cursor"
  );
  expect(backupLine(hours(1), { error: "restic backup: no repository" })).toBe(
    "Last backup: none · restic backup: no repository · OVER 48 H OLD"
  );
});
