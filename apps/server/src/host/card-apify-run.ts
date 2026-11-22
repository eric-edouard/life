import { startRun } from "../apify/backend";
import type { RunApifyByHisWord } from "../memory/decision-add";
import { apifyRunOf } from "../memory/needs";

// An agent's Apify run on his yes (his word of 22 Nov 2026: "don't waste his credits without him knowing"): a card's
// `apify` need started once on his Apify account, exactly its actor and input, held under its `maxUsd` by Apify itself.

/** Starts the card's run on his answer; returns its id, throws when it could not (recorded as `ran`'s error, never retried). */
export const runApifyByHisWord: RunApifyByHisWord = async (d) => {
  const run = apifyRunOf(d.needs);
  if (!run) {
    throw new Error("the card holds no Apify run");
  }
  return await startRun(run.actor, run.input, run.maxUsd);
};
