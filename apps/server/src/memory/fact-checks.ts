import { clock } from "../core/clock";
import { type Doubt, doubtsOf, drawFactChecks, plain } from "./doubts";
import { openFactChecks, readObservations } from "./memory-files";
import { readPeople } from "./who";

// His fact checks: the claims Life is least sure of (`doubtful` only, never recorded text), drawn each night, put to
// him in a chat (`read_fact_checks`) and answered there (`correct_memory`, kind `fact_check`: memory/ratings.jsonl).

/** How many stay open at once. */
const OPEN = 5;
const WHY: Record<Doubt, string> = {
  "guessed-person": "who it's about is only guessed",
  "low-confidence": "the reading itself was unsure",
};

/** Draws new ones until OPEN are open. The caller holds the lock (`drawFactChecks`). */
export async function topUpFactChecks(now = clock().getTime()) {
  const room = OPEN - openFactChecks(now).length;
  return room > 0 ? (await drawFactChecks(room)).length : 0;
}

/** The open fact checks as he is asked them: the claim word for word, why Life doubts it, the words it came from. */
export async function readOpenFactChecks(now = clock().getTime()) {
  const open = openFactChecks(now);
  const [observations, people] = await Promise.all([
    readObservations(),
    readPeople(),
  ]);
  const byId = new Map(observations.map((o) => [o.id as string, o]));
  return open.map((s) => {
    const o = byId.get(s.ref);
    return {
      claim: s.text,
      doubts: o ? doubtsOf(o, people.refOf).map((d) => WHY[d]) : [],
      from: `${s.source ?? "an episode"}, ${plain(s.date)}`,
      quote: o?.quote ?? null,
      ref: s.ref,
    };
  });
}
