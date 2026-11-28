import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { HOME } from "../core/platform";
import { SECRETS } from "../core/secret";
import {
  backupLine,
  backupSettingsOf,
  cloudFoldersOf,
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

test("the cloud folders setup offers: iCloud Drive, then each Google Drive's, then each OneDrive's", () => {
  const home = mkdtempSync(join(tmpdir(), "life-home-"));
  const mkdir = (path: string) =>
    mkdirSync(join(home, path), { recursive: true });
  try {
    expect(cloudFoldersOf(home)).toEqual([]);
    mkdir("Library/CloudStorage/OneDrive-Personal");
    mkdir("Library/CloudStorage/GoogleDrive-ada@example.test/My Drive");
    mkdir("Library/Mobile Documents/com~apple~CloudDocs");
    expect(cloudFoldersOf(home)).toEqual([
      join(home, "Library/Mobile Documents/com~apple~CloudDocs"),
      join(home, "Library/CloudStorage/GoogleDrive-ada@example.test/My Drive"),
      join(home, "Library/CloudStorage/OneDrive-Personal"),
    ]);
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

test("init sets a backup only in the folder it is given, never in one that already holds a Life backup; backup folders lists what setup offers", () => {
  const folder = mkdtempSync(join(tmpdir(), "life-init-"));
  const cloud = join(folder, "cloud");
  const entry = join(import.meta.dir, "../desk/life-entry.ts");
  // A new install each time (`init` runs once): its backup setting, or its exit code when refused.
  const init = (...more: string[]) => {
    const install = mkdtempSync(join(folder, "install-"));
    const state = join(install, "state");
    const { exitCode } = Bun.spawnSync(
      [
        "bun",
        entry,
        "init",
        "--name",
        "Ada Example",
        "--engine",
        "openrouter",
        ...more,
      ],
      {
        env: {
          ...process.env,
          HOME: install,
          LIFE_MACHINE_DIR: join(install, "machine"),
          LIFE_OWNER_DATA_DIR: join(install, "data"),
          LIFE_STATE_DIR: state,
          NODE_ENV: "",
        },
      }
    );
    return exitCode === 0
      ? {
          backup: JSON.parse(readFileSync(join(state, "settings.json"), "utf8"))
            .backup,
          hasKey: existsSync(join(state, "backup.key")),
        }
      : exitCode;
  };
  try {
    expect(init("--backup", cloud)).toBe(2);
    expect(init()).toEqual({ backup: undefined, hasKey: false });
    mkdirSync(cloud);
    expect(init("--backup", cloud)).toMatchObject({
      backup: { repository: join(cloud, "Life backup", "restic") },
      hasKey: true,
    });
    mkdirSync(join(cloud, "Life backup", "restic"), { recursive: true });
    expect(init("--backup", cloud)).toBe(2);
    // What setup offers: the cloud folders of this home, none here.
    const offered = Bun.spawnSync(["bun", entry, "backup", "folders"], {
      env: { ...process.env, HOME: folder },
    });
    expect(JSON.parse(offered.stdout.toString())).toEqual([]);
  } finally {
    rmSync(folder, { force: true, recursive: true });
  }
}, 60_000);
