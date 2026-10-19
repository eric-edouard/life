// How the memory did on facts whose truth is known (the hand-made evals and his ratings), from a judge's grades.

/** What a judge may say of a fact against the claims. */
export const GRADES = ["stated", "contradicted", "both", "absent"] as const;

/** A fact's mark by its truth and its grade: a true must be stated, a false must not be. */
const MARKS = {
  false: { absent: "ok", both: "WRONG", contradicted: "ok", stated: "WRONG" },
  true: { absent: "miss", both: "WRONG", contradicted: "WRONG", stated: "ok" },
} as const;

/**
 * Each fact's grade (the judge names it by its id) and mark, and the counts: `held` true facts the memory states, `missed` true facts it doesn't, `contradicted` true facts it contradicts,
 * `restated` false facts it states (again), `ungraded` facts the judge left out (never read as absent).
 */
export function tally<
  G extends { fact: string; grade: (typeof GRADES)[number] },
>(facts: { id: string; true: boolean }[], list: G[]) {
  const grades = new Map(list.map((g) => [g.fact, g]));
  const marks = new Map(
    facts.map((f) => {
      const grade = grades.get(f.id)?.grade;
      return [f.id, grade ? MARKS[`${f.true}`][grade] : "ungraded"] as const;
    })
  );
  const count = (truth: boolean, mark: string) =>
    facts.filter((f) => f.true === truth && marks.get(f.id) === mark).length;
  return {
    counts: {
      contradicted: count(true, "WRONG"),
      held: count(true, "ok"),
      missed: count(true, "miss"),
      restated: count(false, "WRONG"),
      trues: facts.filter((f) => f.true).length,
      ungraded: [...marks.values()].filter((m) => m === "ungraded").length,
    },
    grades,
    marks,
  };
}
