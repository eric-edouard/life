// The daily restic backup, like Life's: with RESTIC_REPOSITORY, RESTIC_PASSWORD and RESTIC_BINARY
// set (the Mac host), an export (export.ts) is staged beside the archive and snapshotted, tagged
// `daily` from host `lifelog`; on Sundays old snapshots are forgotten and pruned, then 5 % of the
// data read back. It replaces the archive snapshot under `archive/` (backup.ts), which runs only
// without it. The latest snapshot is a `backup_files` row (kind `restic`); the last error is kept in
// memory. The password goes to restic in its environment, never to a log; `GET /status` (readers
// see it) shows neither it nor the repository.
import { rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Db } from "@lifelog/db";
import { backupFiles } from "@lifelog/db/schema";
import { and, eq } from "drizzle-orm";
import type { Config } from "./config";
import { exportArchive } from "./export";

// A day's tries (index.ts tries at most hourly).
const TRIES = 3;
const BACKUP =
  "backup --quiet --tag daily --host lifelog --ignore-inode --ignore-ctime";
const SUNDAY = [
  "forget --tag daily --group-by host,tags --keep-daily 14 --keep-weekly 8 --keep-monthly 24 --prune",
  "check --read-data-subset=5%",
];
const NO_REPOSITORY = /repository does not exist|unable to open config file/i;
// The Mac's day (YYYY-MM-DD), as Sunday is: a day's snapshot and its tries follow the owner's clock.
const localDate = (at: Date) => at.toLocaleDateString("sv-SE");

export function resticFor(db: Db, config: Config) {
  const {
    AUDIO_DIR,
    DATABASE_PATH,
    RESTIC_BINARY,
    RESTIC_PASSWORD,
    RESTIC_REPOSITORY,
  } = config;
  if (!(RESTIC_BINARY && RESTIC_PASSWORD && RESTIC_REPOSITORY)) {
    return null;
  }
  const env = { ...process.env, RESTIC_PASSWORD, RESTIC_REPOSITORY };
  // Fixed, so restic finds the day before's snapshot as its parent.
  const staging = join(dirname(DATABASE_PATH), "restic-staging");
  let lastError: string | null = null;
  let tries = { date: "", n: 0 };
  let busy = false;

  const exec = async (args: string[]) => {
    const proc = Bun.spawn([RESTIC_BINARY, ...args, "--json"], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return {
      code,
      error: `restic ${args[0]}: ${stderr.trim().slice(-300)}`,
      stdout,
    };
  };
  // One restic command; throws its stderr's end unless it exits with one of `ok`.
  const run = async (args: string[], ok = [0]) => {
    const r = await exec(args);
    if (!ok.includes(r.code)) {
      throw new Error(r.error);
    }
    return r;
  };

  async function snapshot(now: Date) {
    // No repository there yet: exit 10 (restic ≥ 0.17), or an older restic's words.
    const there = await exec(["cat", "config"]);
    if (there.code === 10 || NO_REPOSITORY.test(there.error)) {
      await run(["init"]);
    } else if (there.code !== 0) {
      throw new Error(there.error);
    }
    await rm(staging, { force: true, recursive: true });
    await exportArchive(db, AUDIO_DIR, staging);
    // The staging is new each day (new inodes and ctimes, the same mtimes): only content that
    // changed is read again. 3: saved without some file it could not read.
    const backup = await run([...BACKUP.split(" "), staging], [0, 3]);
    const summary = JSON.parse(
      backup.stdout.trim().split("\n").at(-1) ?? ""
    ) as { data_added: number; snapshot_id: string };
    const missed =
      backup.code === 3
        ? [
            "restic backup: the snapshot is incomplete, some files could not be read",
          ]
        : [];
    db.transaction((tx) => {
      tx.delete(backupFiles).where(eq(backupFiles.kind, "restic")).run();
      tx.insert(backupFiles)
        .values({
          bytes: summary.data_added,
          key: `restic/${summary.snapshot_id}`,
          kind: "restic",
          name: localDate(now),
          sha256: summary.snapshot_id,
          sourceId: "server",
        })
        .run();
    });
    // ponytail: a Sunday the Mac sleeps through skips that week's pass; keep the last pass if that matters.
    for (const args of now.getDay() === 0 ? SUNDAY : []) {
      // biome-ignore lint/performance/noAwaitInLoops: forget, then check
      await run(args.split(" ")).catch((error: Error) =>
        missed.push(error.message)
      );
    }
    return missed.join("; ") || null;
  }

  return {
    // Today's snapshot, unless it is taken, three tries failed today, or one runs. True once taken.
    async daily(now = new Date()) {
      const date = localDate(now);
      const taken = db
        .select({ key: backupFiles.key })
        .from(backupFiles)
        .where(and(eq(backupFiles.kind, "restic"), eq(backupFiles.name, date)))
        .get();
      if (tries.date !== date) {
        tries = { date, n: 0 };
      }
      if (taken || busy || tries.n >= TRIES) {
        return false;
      }
      busy = true;
      tries.n += 1;
      try {
        lastError = await snapshot(now);
        return true;
      } catch (error) {
        lastError = (error as Error).message;
        console.error(`restic: ${lastError}`);
        return false;
      } finally {
        await rm(staging, { force: true, recursive: true });
        busy = false;
      }
    },
    // `GET /status` `backup.restic`.
    status() {
      const latest = db
        .select({ at: backupFiles.createdAt })
        .from(backupFiles)
        .where(eq(backupFiles.kind, "restic"))
        .get();
      return {
        lastError,
        lastSnapshotAt: latest?.at.toISOString() ?? null,
      };
    },
  };
}

export type Restic = NonNullable<ReturnType<typeof resticFor>>;
