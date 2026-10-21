import { DATA, isHis } from "./truth";

// Life's one clock: every read of "now" goes through `clock()`. `LIFE_NOW` (an ISO instant) stops it there, for the
// Atlas bench (scripts/bench-atlas.ts): the connector then serves the world as it was at that instant, and a frozen
// world is a dry run (`FROZEN`, mcp.ts). Refused on his own data, like `LIFE_LLM`: only a copy is ever frozen.

/** The instant `LIFE_NOW` freezes the clock at, in ms; none when unset. */
export function frozenAt(set = process.env.LIFE_NOW, data = DATA) {
  if (!set) {
    return;
  }
  if (isHis(data)) {
    throw new Error(
      "LIFE_NOW is for a copy of the data (LIFE_DATA), never ~/Life"
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
