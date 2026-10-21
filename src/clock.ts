import { statSync } from "node:fs";
import { join } from "node:path";
import { DATA, isHis, ROOT, TEST } from "./truth";

// Life's one clock: every read of "now" goes through `clock()`. `LIFE_NOW` (an ISO instant) stops it there, for the
// Atlas bench (scripts/bench-atlas.ts). Frozen, the live sources (lifelog, chats, notes, places) are read up to that
// instant (`dayRange`, `placesOf`); memory, the ledger and the lifelog store are what the bench copied as of then. A
// frozen world is a dry run (`dry`, mcp.ts). Only a copy is ever frozen: never his ~/Life (like `LIFE_LLM`), and never
// in the live checkout, whose derived/ (log, events.json) is production's.

/** Is `root` a checkout of its own (its .git a folder), not a throwaway worktree (a .git file)? */
const isCheckout = (root: string) =>
  statSync(join(root, ".git"), { throwIfNoEntry: false })?.isDirectory() ??
  false;

/** The instant `LIFE_NOW` freezes the clock at, in ms; none when unset. Tests log into their own copy. */
export function frozenAt(
  set = process.env.LIFE_NOW,
  data = DATA,
  live = !TEST && isCheckout(ROOT)
) {
  if (!set) {
    return;
  }
  if (isHis(data)) {
    throw new Error(
      "LIFE_NOW is for a copy of the data (LIFE_DATA), never ~/Life"
    );
  }
  if (live) {
    throw new Error(
      "LIFE_NOW runs in a worktree of its own: this checkout's derived/ is production's"
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

/** Throws in a frozen run: called by everything that acts outside the copy (Reminders, lifelog, email, events). */
export function unfrozen(what: string) {
  if (FROZEN !== undefined) {
    throw new Error(`a frozen run does not ${what}`);
  }
}
