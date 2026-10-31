import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { clock } from "../core/clock";
import { linesOf, readJson } from "../core/files";
import { holder } from "../core/lock";
import { log, recentEvents } from "../core/log";
import {
  isHis,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
} from "../core/paths";
import { FACT_CHECKS } from "../memory/fact-checks";
import { locked } from "../memory/memory-lock";
import { commitMemory } from "../memory/run";

// A rename backfills (AGENTS.md): the one agent becomes agents by name (31 Oct 2026). Its name, from the old settings'
// `agent.name`, is stamped on what it owned: each ask in the ledger (`after.agent`), each decision it asked (its
// `asked` line's `agent`; Life's fact checks have none), and the refresh record of each app that called
// as it (its agent claim; a plain app stays plain). Then
// the settings' `agent` becomes `agents: {<name>: …}` (its `client` and `transport` go). Every line keeps its place and
// its bytes but for the stamp (the `read_memory_changes` cursor counts lines); run twice, it changes nothing. Memory is
// written by the app at its next start, under the lock, committed in his data repo before and after; the state (this
// process's own settings and pairings) once memory is done. It goes, once it ran on his data.

/** The migrations done, one line each (memory/migrations.jsonl): this one's name. */
const STEP = "agents-2026-10-31";
const DONE = "memory/migrations.jsonl";
const LEDGER = "memory/ledger.jsonl";
const DECISIONS = "memory/decisions.jsonl";

/** Does this code run from a repo (a checkout or a worktree) rather than from Life.app's resources? */
const runsFromRepo = () => existsSync(join(LIFE_CODE_DIR, ".git"));
/** Only the running app migrates his own data: a checkout or worktree may migrate a copy, never his live data. */
const mayMigrate = (data: string) => !(runsFromRepo() && isHis(data));

// biome-ignore lint/suspicious/noExplicitAny: lines read before any schema knows the new names
type Row = any;

/** Each line `stamp` changes rewritten, every other one kept as it was. */
const stamped = (text: string, stamp: (r: Row) => boolean) =>
  text
    .split("\n")
    .map((l) => {
      if (!l.trim()) {
        return l;
      }
      const r = JSON.parse(l);
      return stamp(r) ? JSON.stringify(r) : l;
    })
    .join("\n");

/** The ledger with `agent` on every ask that has none. */
export const ledgerOf = (text: string, agent: string) =>
  stamped(text, (r) => {
    if (r.kind !== "ask" || r.after?.agent) {
      return false;
    }
    r.after = { ...r.after, agent };
    return true;
  });

/** The decisions with `agent` on every decision's `asked` line that has none, Life's fact checks aside. */
export const decisionsOf = (text: string, agent: string) =>
  stamped(text, (r) => {
    if (
      r.step !== "asked" ||
      r.agent ||
      `${r.decision}`.startsWith(`${FACT_CHECKS}-`)
    ) {
      return false;
    }
    r.agent = agent;
    return true;
  });

/** The settings with `agents` for the old `agent`, or undefined when there is nothing to rename. */
export function settingsOf(raw: Row): Row | undefined {
  if (!raw?.agent) {
    return undefined;
  }
  const { agent, ...rest } = raw;
  const { misheard, name, start, wake } = agent;
  return {
    ...rest,
    agents: {
      ...rest.agents,
      [name]: {
        ...(misheard ? { misheard } : {}),
        ...(start
          ? { start: { command: start, on: ["tick", "message"] } }
          : {}),
        wake,
      },
    },
  };
}

/**
 * The pairings with `agent` on each refresh record of a client that called as the agent (`clients`), or undefined when
 * none needs it. Every other app stays plain: it reads and has no board.
 */
export function pairingsOf(
  raw: Row,
  agent: string,
  clients: Set<string>
): Row | undefined {
  const refresh = Object.entries(raw?.refresh ?? {}) as [string, Row][];
  const isMine = (r: Row) => !r.agent && clients.has(r.client);
  if (!refresh.some(([, r]) => isMine(r))) {
    return undefined;
  }
  return {
    ...raw,
    refresh: Object.fromEntries(
      refresh.map(([k, r]) => [k, isMine(r) ? { ...r, agent } : r])
    ),
  };
}

/**
 * The OAuth clients whose connector calls (`mcp.call`, the last 30 days of the state's log) came from the old agent:
 * a user agent that starts with its `client` (the old `isAgent` rule, kept here only).
 */
async function agentClientsIn(state: string, old: Row) {
  const prefix =
    old.client ?? (old.transport === "pull" ? "Claude" : "openai-mcp");
  const calls = await recentEvents<{ agent?: string; client?: string }>(
    30,
    "mcp.call",
    join(state, "log")
  );
  return new Set(
    calls
      .filter((e) => e.client && String(e.agent ?? "").startsWith(prefix))
      .map((e) => e.client as string)
  );
}

/** Writes a file whole, its mode kept: a reader never meets half of it. */
function writeWhole(path: string, text: string, mode = 0o644) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

const done = (dir: string) =>
  linesOf(join(dir, DONE)).some((l) => l && JSON.parse(l).name === STEP);

/** Is there anything for the rename to do in memory? */
export const needsRename = (dir = OWNER_DATA_DIR) =>
  existsSync(join(dir, "memory")) && !done(dir);

/** The agent everything stored belongs to: the old settings' one, else the only one there is. */
function agentIn(state: string) {
  const raw: Row = readJson(join(state, "settings.json"));
  const names = Object.keys(raw?.agents ?? {});
  return raw?.agent?.name ?? (names.length === 1 ? names[0] : undefined);
}

/** Memory's stamps, then its line in memory/migrations.jsonl. */
function renameIn(dir: string, agent: string | undefined) {
  const mine = dir === OWNER_DATA_DIR && existsSync(join(dir, ".git"));
  if (mine) {
    commitMemory(["memory"], "Memory: before the agent's name is stamped");
  }
  if (agent) {
    for (const [file, of] of [
      [LEDGER, ledgerOf],
      [DECISIONS, decisionsOf],
    ] as const) {
      const path = join(dir, file);
      const text = existsSync(path) ? readFileSync(path, "utf8") : "";
      const next = of(text, agent);
      if (next !== text) {
        writeWhole(path, next);
      }
    }
  }
  appendFileSync(
    join(dir, DONE),
    `${JSON.stringify({ at: clock().toISOString(), name: STEP, schemaVersion: 1 })}\n`
  );
  if (mine) {
    commitMemory(
      ["memory"],
      "Memory: asks and decisions name their agent (agents-2026-10-31)"
    );
  }
  log("run.end", { step: `memory.migrate.${STEP}` });
}

/** The state's rename: the pairings stamped first (the agent and its clients are the old settings'), then the settings. */
async function renameState(state: string) {
  const path = join(state, "settings.json");
  const raw: Row = readJson(path);
  const oauth = join(state, "oauth", "state.json");
  const pairings = raw?.agent
    ? pairingsOf(
        readJson(oauth),
        raw.agent.name,
        await agentClientsIn(state, raw.agent)
      )
    : undefined;
  if (pairings) {
    writeWhole(oauth, `${JSON.stringify(pairings, null, 2)}\n`, 0o600);
  }
  const settings = settingsOf(raw);
  if (settings) {
    writeWhole(path, `${JSON.stringify(settings, null, 2)}\n`);
  }
}

/** Another Life's watcher still running (the old app's, or a checkout's): it may write memory/ without the lock. */
const otherWatcher = () => {
  const h = holder("watch");
  return h !== null && h.pid !== String(process.pid);
};

/**
 * Runs the rename once, holding memory's lock, while no other watcher runs: the callers (every command, cli.ts) wait
 * meanwhile. Only the app runs it on his own data (`mayMigrate`): a checkout stops instead. The state (settings and
 * pairings) is this process's own (`LIFE_STATE_DIR`, a checkout's derived/), renamed after memory.
 */
export async function migrateStored(
  dir = OWNER_DATA_DIR,
  state = dir === OWNER_DATA_DIR ? LIFE_STATE_DIR : undefined
) {
  const live = !runsFromRepo();
  const agent = state ? agentIn(state) : undefined;
  let said = false;
  /** One try under the lock: true once memory is renamed (by this process or another). */
  const step = () => {
    if (!needsRename(dir)) {
      return true;
    }
    // On the app's data the rename waits for any other watcher (the old app's, a checkout's) to stop.
    if (live && otherWatcher()) {
      if (!said) {
        console.error(
          `The agents' rename waits for the watcher of ${holder("watch")?.note} to stop`
        );
        said = true;
      }
      return false;
    }
    renameIn(dir, agent);
    return true;
  };
  while (needsRename(dir)) {
    if (!mayMigrate(dir)) {
      throw new Error(
        'his memory still has one agent: only the new Life.app renames it (AGENTS.md, "A rename backfills")'
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: waits for the process that holds the lock to finish the rename
    const ran = await locked(() => Promise.resolve(step()));
    if (!ran) {
      await Bun.sleep(5000);
    }
  }
  if (state) {
    await renameState(state);
  }
}
