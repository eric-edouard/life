import { clock, DAY, iso } from "../core/clock";
import type { Decision } from "../records/decision";
import type { Statement } from "../records/statement";
import {
  decisionId,
  decisionsNow,
  FACT_CHECKS,
  writeDecision,
} from "./decisions";
import {
  readObservations,
  readRatings,
  readStatements,
  recordRating,
} from "./ledger";
import { type Doubt, drawDoubtful, plain } from "./statements";

// His fact checks as decisions (his word, 30 Oct 2026: Life's own, not a loop's): Life asks the claims it is least sure
// of on his decisions page and records his answer as a rating (memory/ratings.jsonl). What is asked comes from
// `doubtful` only, never from recorded text.

/** How many stay open at once. */
const OPEN = 5;
const WHY: Record<Doubt, string> = {
  "guessed-person": "who it's about is only guessed",
  "low-confidence": "the reading itself was unsure",
};
const OPTIONS = [
  { id: "true", label: "Right" },
  { id: "partly", label: "Partly" },
  { id: "false", label: "Wrong" },
];

/** One statement as the decision he is shown: its text word for word (in the context too when the question is cut). */
export function factCheckAsk(
  s: Statement,
  doubts: Doubt[],
  quote?: string,
  now = clock().getTime()
) {
  const cut = s.text.length > 200;
  return {
    context: [
      cut ? s.text : "",
      doubts.length > 0
        ? `Life is unsure: ${doubts.map((d) => WHY[d]).join("; ")}.`
        : "",
      quote ? `"${quote}"` : "",
      `From ${s.source ?? "an episode"}, ${plain(s.date)}.`,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 4000),
    deadline: iso(now + 7 * DAY),
    loop: FACT_CHECKS,
    onNoAnswer: "nothing changes",
    options: OPTIONS,
    question: cut ? `${s.text.slice(0, 199)}…` : s.text,
    ref: s.ref,
  };
}

/** His answer to a fact-check decision, recorded as its rating, then the decision is done; a note with no tap counts as Partly. */
export function recordFactCheck(d: Decision) {
  const answer = d.answer === "note" || !d.answer ? "partly" : d.answer;
  recordRating(
    `${d.ref}`,
    answer as "true" | "false" | "partly",
    d.note || undefined
  );
  writeDecision([
    { data: { result: "Recorded in Life" }, decision: d.id, step: "done" },
  ]);
}

/**
 * Keeps his fact checks: records answers not yet recorded, closes the expired ones as skipped, asks what was drawn but
 * never asked, then draws up to 5 open. The caller holds the lock (`drawDoubtful`).
 */
export async function askFactChecks(now = clock().getTime()) {
  const mine = [...decisionsNow().values()];
  for (const d of mine) {
    // One card that can't be closed is logged and left, never the run's failure.
    try {
      if (d.status === "answered") {
        recordFactCheck(d);
      } else if (d.status === "open" && Date.parse(d.deadline ?? "") <= now) {
        recordRating(`${d.ref}`, "skip");
        writeDecision(
          [{ data: { result: "Skipped" }, decision: d.id, step: "expired" }],
          now
        );
      }
    } catch (e) {
      console.error(`fact check ${d.id}: ${(e as Error).message}`);
    }
  }
  const open = mine.filter(
    (d) => d.status === "open" && Date.parse(d.deadline ?? "") > now
  ).length;
  const asked = new Set(mine.map((d) => d.ref));
  const rated = readRatings();
  const waiting = readStatements().filter(
    (s) => !(asked.has(s.ref) || rated.get(s.ref))
  );
  const room = Math.max(0, OPEN - open - waiting.length);
  const drawn = room > 0 ? await drawDoubtful(room) : [];
  const doubts = new Map(drawn.map((d) => [d.statement.ref, d.doubts]));
  const toAsk = [...waiting, ...drawn.map((d) => d.statement)].slice(
    0,
    Math.max(0, OPEN - open)
  );
  if (toAsk.length === 0) {
    return 0;
  }
  const quotes = new Map(
    (await readObservations()).map((o) => [o.id as string, o.quote])
  );
  writeDecision(
    toAsk.map((s, n) => ({
      data: factCheckAsk(s, doubts.get(s.ref) ?? [], quotes.get(s.ref), now),
      decision: decisionId(FACT_CHECKS, now, n + 1),
      step: "asked" as const,
    })),
    now
  );
  return toAsk.length;
}
