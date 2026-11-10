// How well one embedding model, or a blend of several, names the owner's known voices. Profiles and
// ranking are the server's (`weighProfiles` through `profilesWithout`, `rankPeople`); no server
// threshold is used: the bench sweeps its own, so models with different score ranges compare fairly.
import { profilesWithout } from "@lifelog/server/scripts/eval-voices";
import {
  NO_PROFILES,
  type Profile,
  rankPeople,
} from "@lifelog/server/src/speakers";
import type { Vector } from "@lifelog/server/src/voice-vectors";
import type { Truth } from "./truth";

// A turn, or a voice (a speaker's turns in one job, as one vector), heard by one model.
export interface Heard {
  conversationId: string;
  id: string;
  jobId: string;
  seconds: number;
  truth: Truth | undefined;
  vector: Vector;
}

// Whom a model hears: everyone by likeness, the first one's lead over the next.
export interface Call {
  best: string | null;
  id: string;
  margin: number;
  score: number;
  scores: { personId: string; score: number }[];
  truth: Truth | undefined;
}

// Each item against profiles built from the evidence (the turns he named a person for, and the
// strangers': "nobody I know") of every conversation but those of its own job.
export function callsOf(items: Heard[], turns: Heard[]): Call[] {
  const row = (t: Heard, personId: string) => ({
    conversationId: t.conversationId,
    durationSeconds: t.seconds,
    embedding: t.vector,
    isOwner: false,
    modelId: "",
    modelRevision: "",
    personId,
    sampleId: t.id,
  });
  const data = {
    evidence: turns.flatMap((t) =>
      t.truth?.kind === "person" ? [row(t, t.truth.personId)] : []
    ),
    strangers: turns.flatMap((t) =>
      t.truth?.kind === "unknown" ? [row(t, "")] : []
    ),
  };
  const own = Map.groupBy(turns, (t) => t.jobId);
  const cached = new Map<string, Profile[]>();
  return [...Map.groupBy(items, (i) => i.jobId)].flatMap(([jobId, inJob]) => {
    const conversations = new Set(
      [...inJob, ...(own.get(jobId) ?? [])].map((t) => t.conversationId)
    );
    const key = [...conversations].sort().join();
    const people =
      cached.get(key) ??
      ([...profilesWithout(data, conversations).values()][0] ?? NO_PROFILES)
        .people;
    cached.set(key, people);
    return inJob.map((item) => callOf(item, rankPeople(item.vector, people)));
  });
}

const callOf = (
  { id, truth }: Pick<Heard, "id" | "truth">,
  ranked: { margin: number; personId: string; score: number }[]
): Call => ({
  best: ranked[0]?.personId ?? null,
  id,
  margin: ranked[0]?.margin ?? 0,
  score: ranked[0]?.score ?? Number.NEGATIVE_INFINITY,
  scores: ranked.map(({ personId, score }) => ({ personId, score })),
  truth,
});

// Several models as one: each person's likeness is the mean of the models' z-scored likenesses
// (a model's scores, over every item and person, brought to mean 0 and deviation 1).
export function blendOf(models: Call[][]): Call[] {
  const scaled = models.map((calls) => {
    const all = calls.flatMap((c) => c.scores.map((s) => s.score));
    const mean = all.reduce((sum, x) => sum + x, 0) / (all.length || 1);
    const deviation =
      Math.sqrt(
        all.reduce((sum, x) => sum + (x - mean) ** 2, 0) / (all.length || 1)
      ) || 1;
    return new Map(
      calls.map((c) => [
        c.id,
        new Map(
          c.scores.map((s) => [s.personId, (s.score - mean) / deviation])
        ),
      ])
    );
  });
  return (models[0] ?? []).flatMap((first) => {
    const heard = scaled.map((model) => model.get(first.id));
    if (heard.some((h) => !h)) {
      return [];
    }
    const ranked = first.scores
      .flatMap(({ personId }) => {
        const each = heard.map((h) => h?.get(personId));
        return each.includes(undefined)
          ? []
          : [
              {
                personId,
                score:
                  each.reduce((sum: number, x) => sum + (x ?? 0), 0) /
                  each.length,
              },
            ];
      })
      .sort((a, b) => b.score - a.score);
    const lead = (ranked[0]?.score ?? 0) - (ranked[1]?.score ?? 0);
    return [
      callOf(
        first,
        ranked.map((r) => ({ ...r, margin: lead }))
      ),
    ];
  });
}

const isKnown = (c: Call) => c.truth?.kind === "person";
const isRight = (c: Call) =>
  c.truth?.kind === "person" && c.truth.personId === c.best;
// Judged: he answered, and the clip is one voice.
const judged = (calls: Call[]) =>
  calls.filter((c) => c.truth && c.truth.kind !== "excluded");

const quantile = (sorted: number[], q: number) =>
  sorted[Math.floor(q * (sorted.length - 1))] ?? 0;

export interface Point {
  margin: number;
  named: number;
  // Known voices named right, of all known voices.
  namedRight: number;
  right: number;
  threshold: number;
  // Wrong names, of all names given. A name given to a voice he doesn't know is wrong.
  wrongShare: number;
}

// The most known voices named right while at most `budget` of the names given are wrong: the best
// score threshold for each of a few leads (none, and the 10th, 25th and 50th percentile of leads).
export function pointAt(calls: Call[], budget: number): Point {
  const all = judged(calls);
  const known = all.filter(isKnown).length || 1;
  const leads = all.map((c) => c.margin).sort((a, b) => a - b);
  let best: Point = {
    margin: 0,
    named: 0,
    namedRight: 0,
    right: 0,
    threshold: Number.POSITIVE_INFINITY,
    wrongShare: 0,
  };
  for (const margin of [
    Number.NEGATIVE_INFINITY,
    ...[0.1, 0.25, 0.5].map((q) => quantile(leads, q)),
  ]) {
    const named = all
      .filter((c) => c.best && c.margin >= margin)
      .sort((a, b) => b.score - a.score);
    let right = 0;
    named.forEach((c, i) => {
      right += isRight(c) ? 1 : 0;
      const wrongShare = (i + 1 - right) / (i + 1);
      // Only where the score changes: equal scores are named together.
      if (
        wrongShare <= budget &&
        right > best.right &&
        named[i + 1]?.score !== c.score
      ) {
        best = {
          margin,
          named: i + 1,
          namedRight: right / known,
          right,
          threshold: c.score,
          wrongShare,
        };
      }
    });
  }
  return best;
}

export const isNamed = (c: Call, at: Pick<Point, "margin" | "threshold">) =>
  !!c.best && c.score >= at.threshold && c.margin >= at.margin;

// Known voices named right against wrong names, as the score threshold falls (no lead asked).
export function curveOf(calls: Call[], points = 80): [number, number][] {
  const all = judged(calls);
  const known = all.filter(isKnown).length || 1;
  const named = all.filter((c) => c.best).sort((a, b) => b.score - a.score);
  const step = Math.max(1, Math.floor(named.length / points));
  let right = 0;
  return named.flatMap((c, i): [number, number][] => {
    right += isRight(c) ? 1 : 0;
    return (i + 1) % step === 0 || i === named.length - 1
      ? [[(i + 1 - right) / (i + 1), right / known]]
      : [];
  });
}

// Where the model is as often wrong one way as the other: a known voice scoring under the
// threshold for its own person, and anyone scoring over it for somebody else. Lower is better.
export function equalErrorOf(calls: Call[]) {
  const all = judged(calls);
  const own = all.flatMap(({ scores, truth }) => {
    const mine =
      truth?.kind === "person"
        ? scores.find((s) => s.personId === truth.personId)
        : undefined;
    return mine ? [mine.score] : [];
  });
  const others = all.flatMap(({ scores, truth }) => {
    const other = scores.find(
      (s) => truth?.kind !== "person" || s.personId !== truth.personId
    );
    return other ? [other.score] : [];
  });
  const sortedOwn = own.toSorted((a, b) => a - b);
  const sortedOthers = others.toSorted((a, b) => a - b);
  let best = 1;
  let gap = Number.POSITIVE_INFINITY;
  let over = sortedOthers.length;
  let i = 0;
  // Sweep the threshold over the known voices' own scores.
  sortedOwn.forEach((threshold, under) => {
    while (i < sortedOthers.length && (sortedOthers[i] ?? 0) < threshold) {
      i += 1;
      over -= 1;
    }
    const missed = under / sortedOwn.length;
    const taken = over / (sortedOthers.length || 1);
    if (Math.abs(missed - taken) < gap) {
      gap = Math.abs(missed - taken);
      best = (missed + taken) / 2;
    }
  });
  return best;
}

// Known voices named right at a point, for each group of `groupOf` (a length, a language, a person).
export function sharesBy(
  calls: Call[],
  at: Pick<Point, "margin" | "threshold">,
  groupOf: (c: Call) => string | undefined
) {
  return [
    ...Map.groupBy(
      judged(calls).filter((c) => isKnown(c) && groupOf(c) !== undefined),
      groupOf
    ),
  ]
    .map(([group, inGroup]) => ({
      firstRight: inGroup.filter(isRight).length / inGroup.length,
      group: group ?? "",
      known: inGroup.length,
      namedRight:
        inGroup.filter((c) => isNamed(c, at) && isRight(c)).length /
        inGroup.length,
    }))
    .sort((a, b) => b.known - a.known);
}
