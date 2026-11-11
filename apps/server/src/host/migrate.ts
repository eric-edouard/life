import { appendFileSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { linesOf } from "../core/files";
import { isHis, LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { locked } from "../memory/memory-lock";
import { commitMemory } from "../memory/run";
import { Zone } from "../records/unit";

// A new field backfills (AGENTS.md): `source: "mail"` on the zone runs the history collection appended (Nov 2026, his
// OK). They are the lines on a fixed `Etc/GMT±N` offset, a one-off rule checked on his data: none of his own records
// is one. Each line is rewritten in place (same count, same order). Written by the app at its next start, under the
// lock, committed in his data repo before and after; run twice, it changes nothing. It goes, once it ran on his data.

const STEP = "zone-sources-2026-11";
const DONE = "memory/migrations.jsonl";
const ZONES_FILE = "memory/zones.jsonl";

/** Only the running app migrates his own data: a checkout or worktree may migrate a copy, never his live data. */
const mayMigrate = (data: string) =>
  !(existsSync(join(LIFE_CODE_DIR, ".git")) && isHis(data));

const isDone = (dir: string) =>
  linesOf(join(dir, DONE)).some((l) => l && JSON.parse(l).name === STEP);

/** Zone lines with `source: "mail"` on every fixed-offset run. */
export const taggedOf = (lines: string[]) =>
  lines.map((l) => {
    if (!l) {
      return l;
    }
    const zone = Zone.parse(JSON.parse(l));
    return zone.tz.startsWith("Etc/GMT")
      ? JSON.stringify({ ...zone, source: "mail" }, [
          "from",
          "schemaVersion",
          "source",
          "tz",
        ])
      : l;
  });

/** Runs the backfill once, holding memory's lock; every command waits for it (cli.ts). */
export async function migrateStored(dir = OWNER_DATA_DIR) {
  if (!existsSync(join(dir, "memory")) || isDone(dir)) {
    return;
  }
  if (!mayMigrate(dir)) {
    throw new Error(
      'his zone runs are not tagged yet: only the new Life.app does it (AGENTS.md, "A rename or a new field backfills")'
    );
  }
  await locked(() => {
    const mine = dir === OWNER_DATA_DIR && existsSync(join(dir, ".git"));
    if (mine) {
      commitMemory(["memory"], "Memory: before the zone runs are tagged");
    }
    const path = join(dir, ZONES_FILE);
    const lines = taggedOf(linesOf(path));
    if (lines.length > 0) {
      writeFileSync(`${path}.${process.pid}.tmp`, `${lines.join("\n")}\n`);
      renameSync(`${path}.${process.pid}.tmp`, path);
    }
    appendFileSync(
      join(dir, DONE),
      `${JSON.stringify({ at: clock().toISOString(), name: STEP, schemaVersion: 1 })}\n`
    );
    if (mine) {
      commitMemory(
        ["memory"],
        `Memory: zone runs from his sent mail are tagged (${STEP})`
      );
    }
    return Promise.resolve();
  });
}
