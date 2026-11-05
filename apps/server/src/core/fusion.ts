// How search merges its rankings (by meaning, by words): reciprocal rank fusion. Each ranking gives an item
// 1 / (K + its rank), the sums rank the union, so an item found by both beats one found by either alone. K = 60 is the
// usual value; it kept the bench's meaning results and lifted its keyword ones, where the scores of the two rankings
// can't be added.
const K = 60;

/** The ids of `rankings` (each best first), with their fused score, best first. */
export function fuse(rankings: readonly (readonly string[])[]) {
  const score = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [i, id] of ranking.entries()) {
      score.set(id, (score.get(id) ?? 0) + 1 / (K + i + 1));
    }
  }
  return [...score].sort(([, a], [, b]) => b - a);
}
