import { cosine, type Vector } from "./speakers";

interface Best {
  b: number;
  score: number;
}

// Exact average linkage: dotting unnormalized group sums is the sum of every pair's cosine.
// Memory is O(n * dimensions), not an all-pairs matrix. Of equal pairs, the last merges.
export async function averageLinkage(vectors: Vector[], threshold: number) {
  const groups: (number[] | null)[] = vectors.map((_, i) => [i]);
  const sums = vectors.map((v) => [...v]);
  const average = (a: number, b: number) =>
    cosine(sums[a] ?? [], sums[b] ?? []) /
    ((groups[a]?.length ?? 1) * (groups[b]?.length ?? 1));
  let yieldedAt = performance.now();
  const bestOf = async (a: number) => {
    let best: Best = { b: -1, score: Number.NEGATIVE_INFINITY };
    for (let b = a + 1; b < groups.length; b += 1) {
      if (groups[b]) {
        const score = average(a, b);
        if (score >= best.score) {
          best = { b, score };
        }
      }
      if (b % 256 === 0 && performance.now() - yieldedAt >= 16) {
        // biome-ignore lint/performance/noAwaitInLoops: keep requests moving during a full regroup
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        yieldedAt = performance.now();
      }
    }
    return best;
  };
  const best: Best[] = [];
  for (let a = 0; a < groups.length; a += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: each row yields during its scan
    best.push(await bestOf(a));
  }
  for (let a = nextMerge(best, groups, threshold); a >= 0; ) {
    const b = best[a]?.b ?? -1;
    groups[a] = (groups[a] ?? []).concat(groups[b] ?? []);
    groups[b] = null;
    const sum = sums[a] ?? [];
    for (let d = 0; d < sum.length; d += 1) {
      sum[d] = (sum[d] ?? 0) + (sums[b]?.[d] ?? 0);
    }
    sums[b] = [];
    // biome-ignore lint/performance/noAwaitInLoops: each merge yields during its row scans
    await afterMerge(best, groups, average, bestOf, [a, b]);
    a = nextMerge(best, groups, threshold);
  }
  return groups.filter((g): g is number[] => !!g && g.length > 1);
}

function nextMerge(best: Best[], groups: unknown[], threshold: number) {
  let pick = -1;
  let score = threshold;
  for (const [a, { b, score: alike }] of best.entries()) {
    if (groups[a] && b >= 0 && alike >= score) {
      pick = a;
      score = alike;
    }
  }
  return pick;
}

// Only rows whose best changed need rescanning; earlier rows may now prefer the merged sum.
async function afterMerge(
  best: Best[],
  groups: unknown[],
  average: (a: number, b: number) => number,
  bestOf: (a: number) => Promise<Best>,
  [a, b]: [number, number]
) {
  for (let k = 0; k <= b; k += 1) {
    const row = best[k];
    if (!(row && groups[k])) {
      continue;
    }
    if (k === a || row.b === a || row.b === b) {
      // biome-ignore lint/performance/noAwaitInLoops: each row yields during its scan
      best[k] = await bestOf(k);
    } else if (k < a) {
      const score = average(k, a);
      if (score > row.score || (score === row.score && a > row.b)) {
        best[k] = { b: a, score };
      }
    }
  }
}
