// How the memory (or the agent, in its bench) did on facts whose truth is known (the hand-made evals, his ratings, the
// bench's checks): a judge's grades, and what they come to.
import { join } from "node:path";
import { z } from "zod";
import { askOnce, llmFor } from "../models/llm";

/** What a judge may say of a fact against the claims. */
export const GRADES = ["stated", "contradicted", "both", "absent"] as const;

const Grades = z.object({
  grades: z.array(
    z.object({
      claims: z.array(z.string()).default([]),
      fact: z.string(),
      grade: z.enum(GRADES),
      why: z.string().default(""),
    })
  ),
});
export type Grade = z.infer<typeof Grades>["grades"][number];

/** A fact as the judge reads it, with the day it is judged as of when it has one. */
interface JudgedFact {
  date?: string;
  fact: string;
  id: string;
}
/** A claim as the judge reads it: what was said, and the day. */
interface ClaimLine {
  date: string;
  id: string;
  text: string;
}

/** The judge's calls: the facts of each day with the claims said by then; facts with no day with every claim. */
export const asOf = (facts: JudgedFact[], claims: ClaimLine[]) =>
  [...Map.groupBy(facts, (f) => f.date ?? "")].map(([date, group]) => ({
    claims: date ? claims.filter((c) => c.date <= date) : claims,
    date,
    facts: group,
  }));

/**
 * A judge's grades (his engine's main tier) of `facts` against `claims` (`text` is what was said, `id` names it, `date`
 * the day it was said). A fact with a `date` is judged as of that day, against the claims said on or before it, so a
 * later change never contradicts a state true then; one call per date (`asOf`), facts without one against every claim.
 * Inputs and replies kept in `dir`. Facts go without their truth: the judge isn't told which should hold.
 */
export async function judge(
  facts: JudgedFact[],
  claims: ClaimLine[],
  o: { dir: string; engine?: Parameters<typeof llmFor>[1]; run: string }
) {
  const calls = await Promise.all(
    asOf(facts, claims).map(
      async (call) =>
        Grades.parse(
          await askOnce({
            dir: call.date ? join(o.dir, call.date) : o.dir,
            input: {
              claims: call.claims,
              facts: call.facts.map(({ fact, id }) => ({ fact, id })),
            },
            llm: llmFor("main", o.engine),
            prompt: "eval-judge.v2",
            run: o.run,
          })
        ).grades
    )
  );
  return calls.flat();
}

/**
 * A fact's mark by its truth and its grade: a true must be stated, a false must not be. Kept both (the memory states
 * it and contradicts it) is its own mark: a contradiction stored, not a falsehood held.
 */
const MARKS = {
  false: { absent: "ok", both: "both", contradicted: "ok", stated: "WRONG" },
  true: { absent: "miss", both: "both", contradicted: "WRONG", stated: "ok" },
} as const;

/**
 * Each fact's grade (the judge names it by its id) and mark, and the counts: `held` true facts the memory states, `missed` true facts it doesn't, `contradicted` true facts it contradicts,
 * `restated` false facts it states (again), `both` facts it states and contradicts (kept both), `ungraded` facts the judge left out (never read as absent). An `outdated`
 * fact (true then, not anymore) is a true one held, not judged, and counted apart: Life should have closed it itself.
 */
export function tally<
  G extends { fact: string; grade: (typeof GRADES)[number] },
>(facts: { id: string; outdated?: boolean; true: boolean }[], list: G[]) {
  const grades = new Map(list.map((g) => [g.fact, g]));
  const marks = new Map(
    facts.map((f) => {
      const grade = f.outdated ? "stated" : grades.get(f.id)?.grade;
      return [f.id, grade ? MARKS[`${f.true}`][grade] : "ungraded"] as const;
    })
  );
  const count = (truth: boolean, mark: string) =>
    facts.filter((f) => f.true === truth && marks.get(f.id) === mark).length;
  return {
    counts: {
      both: [...marks.values()].filter((m) => m === "both").length,
      contradicted: count(true, "WRONG"),
      held: count(true, "ok"),
      missed: count(true, "miss"),
      outdated: facts.filter((f) => f.outdated).length,
      restated: count(false, "WRONG"),
      trues: facts.filter((f) => f.true).length,
      ungraded: [...marks.values()].filter((m) => m === "ungraded").length,
    },
    grades,
    marks,
  };
}
