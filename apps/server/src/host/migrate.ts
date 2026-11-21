import {
  appendFileSync,
  existsSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clock, iso } from "../core/clock";
import { linesOf } from "../core/files";
import { log } from "../core/log";
import { LIFE_CODE_DIR, OWNER_DATA_DIR } from "../core/paths";
import { isOwnLife } from "../core/platform";
import { commitMemory, LEDGER, MEMORY } from "../memory/memory-files";
import { locked } from "../memory/memory-lock";

// A rename backfills (AGENTS.md): `change_registered_agent`'s `personal` flag is now `role: "personal"` (PR 832). This
// file is the one place that knows both: the desk's asks in the ledger are rewritten in place (same count, same order,
// so the `read_memory_changes` cursor and the desk's cursor hold), so an ask the old connector took just before the
// upgrade still applies. Once, by the app, under the lock, committed in his data repo. It goes once it ran on his data.

const STEP = "agent-change-role-2026-11";
const DONE = join(MEMORY, "migrations.jsonl");

/** One ledger line with its ask's `agentChange.personal` as `role` (`true`: `personal`; `false`: none); any other line as it is. Pure. */
export function roleLineOf(line: string) {
  if (!line.includes('"personal"')) {
    return line;
  }
  const row = JSON.parse(line);
  const change = row?.after?.agentChange;
  if (!(change && typeof change === "object" && "personal" in change)) {
    return line;
  }
  const { personal, ...rest } = change;
  const agentChange = Object.fromEntries(
    Object.entries(
      personal === true ? { ...rest, role: "personal" } : rest
    ).toSorted(([a], [b]) => (a < b ? -1 : 1))
  );
  return JSON.stringify({ ...row, after: { ...row.after, agentChange } });
}

const isDone = () =>
  linesOf(DONE).some((l) => l && JSON.parse(l).name === STEP);

function migrate() {
  const lines = existsSync(LEDGER)
    ? readFileSync(LEDGER, "utf8").split("\n")
    : [];
  const next = lines.map(roleLineOf);
  const changed = next.filter((l, i) => l !== lines[i]).length;
  if (changed > 0) {
    writeFileSync(`${LEDGER}.migrating`, next.join("\n"));
    renameSync(`${LEDGER}.migrating`, LEDGER);
  }
  appendFileSync(
    DONE,
    `${JSON.stringify({ at: iso(clock().getTime()), name: STEP })}\n`
  );
  if (existsSync(join(OWNER_DATA_DIR, ".git"))) {
    commitMemory(
      ["memory/ledger.jsonl", "memory/migrations.jsonl"],
      `Memory: the desk's asks name the Personal agent by its role (${STEP})`
    );
  }
  log("run.end", { changed, step: `memory.migrate.${STEP}` });
}

/**
 * Runs the rewrite once, holding memory's lock; every command but the archive waits for it (`cli.ts`). Only the app
 * rewrites his own ledger: a checkout on his data stops instead, until the app has.
 */
export async function migrateAgentChangeRole() {
  while (existsSync(MEMORY) && !isDone()) {
    if (existsSync(join(LIFE_CODE_DIR, ".git")) && isOwnLife()) {
      throw new Error(
        'his ledger is not migrated yet: only the new Life.app does it (AGENTS.md, "A rename or a new field backfills")'
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the run holding the lock
    const ran = await locked(() => {
      if (!isDone()) {
        migrate();
      }
      return Promise.resolve(true);
    });
    if (!ran) {
      await Bun.sleep(5000);
    }
  }
}
