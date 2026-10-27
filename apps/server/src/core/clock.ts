import { statSync } from "node:fs";
import { join } from "node:path";
import {
  isHis,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
  TEST,
} from "./paths";

// Life's one clock: every read of "now" goes through `clock()`. `LIFE_NOW` (an ISO instant) stops it there, for the
// The agent bench (scripts/bench-agent.ts). Frozen, the live sources (lifelog, chats, notes, places) are read up to that
// instant (`dayRange`, `placesOf`); memory, the ledger and the lifelog store are what the bench copied as of then. A
// frozen world is a dry run (`dry`, mcp.ts). Only a copy is ever frozen: never his ~/Life (like `LIFE_LLM`), and never
// in the live checkout, whose derived/ (log, events.json) is production's.

/** Is `root` a checkout of its own (its .git a folder), not a throwaway worktree (a .git file)? */
const isMainCheckout = (root: string) =>
  statSync(join(root, ".git"), { throwIfNoEntry: false })?.isDirectory() ??
  false;

/** The instant `LIFE_NOW` freezes the clock at, in ms; none when unset. Tests log into their own copy. */
export function frozenAt(
  set = process.env.LIFE_NOW,
  data = OWNER_DATA_DIR,
  live = !TEST &&
    (isMainCheckout(LIFE_CODE_DIR) || !LIFE_STATE_DIR.startsWith(LIFE_CODE_DIR))
) {
  if (!set) {
    return;
  }
  if (isHis(data)) {
    throw new Error(
      "LIFE_NOW is for a copy of the data (LIFE_OWNER_DATA_DIR), never ~/Life"
    );
  }
  if (live) {
    throw new Error(
      "LIFE_NOW runs in a worktree of its own, with its own state: this checkout's derived/ (or LIFE_STATE_DIR) is production's"
    );
  }
  const ms = Date.parse(set);
  if (Number.isNaN(ms)) {
    throw new Error(`LIFE_NOW is an ISO instant, not ${set}`);
  }
  return ms;
}

/** Set when this process runs frozen: the bench's world, where nothing acts or sends. */
export const FROZEN = frozenAt();

export const clock = () => new Date(FROZEN ?? Date.now());

export const MIN = 60_000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;
/** An instant in ms, as the ledgers write it. */
export const iso = (ms: number) => new Date(ms).toISOString();

/** Throws in a frozen run: called by everything that acts outside the copy (Reminders, lifelog, email, events). */
export function unfrozen(what: string) {
  if (FROZEN !== undefined) {
    throw new Error(`a frozen run does not ${what}`);
  }
}
