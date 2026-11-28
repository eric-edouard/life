import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { HOME } from "../core/platform";
import { SECRETS } from "../core/secret";
import {
  backupLine,
  backupSettingsOf,
  cloudFolderOf,
  readBackupTarget,
} from "./backup";

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

test("the first cloud folder found is the backup's: iCloud Drive, then Google Drive's, then OneDrive's", () => {
  const home = mkdtempSync(join(tmpdir(), "life-home-"));
  const mkdir = (path: string) =>
    mkdirSync(join(home, path), { recursive: true });
  try {
    expect(cloudFolderOf(home)).toBeUndefined();
    mkdir(join("Library", "CloudStorage", "OneDrive-Personal"));
    expect(cloudFolderOf(home)).toBe(
      join(home, "Library/CloudStorage/OneDrive-Personal")
    );
    mkdir(join("Library", "CloudStorage", "GoogleDrive-ada@example.test"));
    expect(cloudFolderOf(home)).toBe(
      join(home, "Library/CloudStorage/GoogleDrive-ada@example.test/My Drive")
    );
    mkdir(join("Library", "Mobile Documents", "com~apple~CloudDocs"));
    expect(cloudFolderOf(home)).toBe(
      join(home, "Library/Mobile Documents/com~apple~CloudDocs")
    );
  } finally {
    rmSync(home, { force: true, recursive: true });
  }
});

test("a new install's backup setting is a repository in the cloud folder, its password Life's own secret", () => {
  expect(backupSettingsOf("/cloud/iCloud Drive")).toEqual({
    password: `cat '${SECRETS.backupKey}'`,
    repository: "/cloud/iCloud Drive/Life backup/restic",
  });
});

test("Life's backup target is the setting resolved: the repository expanded, the password its command's output", async () => {
  // The test run's settings name `echo made-up` and `~/made-up-backup`.
  expect(await readBackupTarget()).toEqual({
    password: "made-up",
    repository: join(HOME, "made-up-backup"),
  });
});
