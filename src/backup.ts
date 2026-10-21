import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { STORES } from "./archive";
import { clock } from "./clock";
import { LOCK, locked } from "./memory/guard";
import { readJson } from "./memory/ledger";
import { INDEX } from "./memory/search";
import { localTime } from "./memory/units";
import { exec } from "./proc";
import { expand, settings } from "./settings";
import { ARCHIVE, archiveDb } from "./sources/archived";
import { storeFiles, WATCH } from "./sources/lifelog";
import { DATA, ROOT, STATE } from "./truth";

// The daily restic snapshot (AGENTS.md, "Backups") to the `backup` setting's repository, run by the nightly's tick
// (`backupDue`). Without the setting there is no backup, and the report says it is off.
const STAGING = join(dirname(ARCHIVE), "backup-staging");
const STATUS = join(STATE, "backup.json");

/** Whether this install backs up at all. */
export const backupOn = () => !!settings().backup;

/** The last good snapshot (when, its size, its id) and what went wrong in the last run. */
interface Status {
  bytes?: number;
  error?: string;
  okAt?: string;
  snapshot?: string;
}

export const readBackup = () => readJson<Status>(STATUS);
/** No good snapshot in the last 48 h. */
export const backupOld = (now: Date, s = readBackup()) =>
  !s?.okAt || now.getTime() - Date.parse(s.okAt) > 48 * 3_600_000;
export const backupSize = (s = readBackup()) =>
  `${((s?.bytes ?? 0) / 1e9).toFixed(1)} GB`;

/** The nightly report's line, flagged when the last run went wrong or the last snapshot is over 48 h old. */
export function backupLine(now: Date, s = readBackup()) {
  if (!backupOn()) {
    return "Backup: off";
  }
  const size = backupSize(s);
  const last = s?.okAt ? `${localTime(s.okAt)}, ${size}` : "none";
  const old = backupOld(now, s);
  return `Last backup: ${[last, s?.error, old && "OVER 48 H OLD"].filter(Boolean).join(" · ")}`;
}

/** `bun life backup`: stages the databases and ~/Life, snapshots, and on Sundays forgets, prunes and checks. */
export async function backup() {
  const target = settings().backup;
  if (!target) {
    return 0;
  }
  const env = {
    ...process.env,
    RESTIC_PASSWORD_COMMAND: target.password,
    RESTIC_REPOSITORY: expand(target.repository),
  };
  const missed: string[] = [];
  const run = async (cmd: string[]) => {
    const r = await exec(cmd, { env, timeout: 3_600_000 });
    if (r.code !== 0) {
      const what = cmd.slice(0, 3).join(" ");
      missed.push(`${what}: ${r.stderr.trim().slice(-300)}`);
    }
    return r;
  };
  rmSync(STAGING, { force: true, recursive: true });
  mkdirSync(STAGING);
  // Every store there is, on or off: an archive turned off still holds the only copy of what was deleted. The cursor
  // before its store: the watcher writes it after, so a restored store never lags its cursor.
  const { cursor, file } = storeFiles();
  if (existsSync(cursor)) {
    await run(["cp", cursor, STAGING]);
  }
  for (const db of [...STORES.map((s) => archiveDb(s.name)), file].filter(
    existsSync
  )) {
    const to = `${STAGING}/${basename(db)}`;
    // biome-ignore lint/performance/noAwaitInLoops: one copy at a time
    await run(["sqlite3", "-readonly", db, `.backup '${to}'`]);
  }
  // ~/Life holds ledger lines not committed yet, so git alone is not whole: an APFS clone under the lock is, in ms.
  if (!(await locked(() => run(["cp", "-cR", DATA, `${STAGING}/Life`])))) {
    missed.push("Life's lock was held");
  }
  // Host `life`: the Mac's name changes with the network, and restic groups snapshots by host. Exit 3: saved
  // without the paths it could not read.
  const r = await run([
    ..."restic backup --json --quiet --tag daily --host life".split(" "),
    ...[basename(LOCK), `${INDEX}*`, WATCH].map((p) => `--exclude=${p}`),
    ...[STAGING, `${ARCHIVE}/media`, `${ROOT}/.env`, STATE],
  ]);
  const sum =
    (r.code === 0 || r.code === 3) &&
    JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "");
  // ponytail: a Sunday the Mac never wakes skips that week's pass; track the last pass if that ever matters.
  if (sum && clock().getDay() === 0) {
    const forget =
      "forget --tag daily --group-by host,tags --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --prune";
    await run(["restic", ...forget.split(" ")]);
    await run(["restic", "check", "--read-data-subset=5%"]);
  }
  const status: Status = {
    ...readJson<Status>(STATUS),
    ...(sum && {
      bytes: sum.total_bytes_processed,
      okAt: sum.backup_end,
      snapshot: sum.snapshot_id.slice(0, 8),
    }),
    error: missed.join("; ") || undefined,
  };
  writeFileSync(STATUS, `${JSON.stringify(status)}\n`);
  // The nightly's launchd log keeps every run's errors; the status only the last.
  console.error(clock().toISOString(), status.error ?? "ok");
  return Number(missed.length > 0);
}
