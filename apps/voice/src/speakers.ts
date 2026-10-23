// Who spoke each turn (docs/voice/processing.md, "Speakers"), in two steps:
// - a speaker's clean turns together are the person their voice matches: cosine at least
//   `matchThreshold` to the profile and `margin` ahead of the next person;
// - a turn whose own voice is nearest the owner's, at `ownerTurn` or more, is his, whoever the
//   speaker is. The provider often puts him and someone else under one speaker. A turn under
//   `shortTurnSeconds` needs only `ownerShortTurn` when it is also `margin` ahead of the next person.
// A voice the owner said is several people is no one: each turn is decided among his candidates.
// Measured on the owner's corrections, this is as good as the label rules it replaced on other
// people and better on the owner. The caller leaves out what the owner answered: his answers win.

import type { Candidates } from "@life/voice-db/schema";
import { RECOGNITION } from "./config";

export type Vector = number[];

export interface Profile {
  isOwner: boolean;
  personId: string;
  vector: Vector;
}

// Embeddings are L2-normalized, so the dot product is the cosine.
export const cosine = (a: Vector, b: Vector) =>
  a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

export function unit(v: Vector): Vector {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export const centroid = (vectors: Vector[]): Vector =>
  unit(vectors.reduce((acc, v) => acc.map((x, i) => x + (v[i] ?? 0))));

// The person a voice sounds most like, and its lead over the next one. With a single profile the
// runner-up counts as 0: unrelated voices score near 0 with ECAPA.
function nearest(vector: Vector, profiles: Profile[]) {
  const [best, next] = profiles
    .map((p) => ({ ...p, score: cosine(vector, p.vector) }))
    .sort((a, b) => b.score - a.score);
  return best ? { ...best, margin: best.score - (next?.score ?? 0) } : null;
}

// One speaker of a transcript: who its voice is (null when below the threshold or not ahead
// enough), and the turns that are someone else's: the owner's, or each one's among `candidates`.
// `samples` are its clean turns of one embedding model, `vector` their voice (null with too little
// speech; people.ts `speakerVoice`), `profiles` that model's.
export function decide(
  {
    samples,
    vector,
  }: {
    samples: {
      durationSeconds: number;
      embedding: Vector;
      turnIndex: number;
    }[];
    vector: Vector | null;
  },
  profiles: Profile[],
  candidates?: Candidates | null
) {
  const owner = profiles.find((p) => p.isOwner)?.personId;
  const best = vector && !candidates ? nearest(vector, profiles) : null;
  const personId =
    best &&
    best.score >= RECOGNITION.matchThreshold &&
    best.margin >= RECOGNITION.margin
      ? best.personId
      : null;
  // Among candidates: the nearest of them, `margin` ahead; a closed set (no "unknown too", each
  // with a profile) takes a weaker match. Else a turn nearest the owner's voice is his.
  const among = profiles.filter(
    (p) => candidates?.people.includes(p.personId) ?? true
  );
  const closed =
    !candidates?.unknown && among.length === candidates?.people.length;
  const least = closed ? RECOGNITION.closedSetTurn : 1;
  const takes = (
    t: NonNullable<ReturnType<typeof nearest>>,
    seconds: number
  ) =>
    candidates
      ? t.margin >= RECOGNITION.margin &&
        t.score >=
          Math.min(
            least,
            t.isOwner ? RECOGNITION.ownerTurn : RECOGNITION.matchThreshold
          )
      : t.personId === owner &&
        (t.score >= RECOGNITION.ownerTurn ||
          (seconds < RECOGNITION.shortTurnSeconds &&
            t.score >= RECOGNITION.ownerShortTurn &&
            t.margin >= RECOGNITION.margin));
  const turns =
    candidates || (owner && personId !== owner)
      ? samples.flatMap((s) => {
          const t = nearest(s.embedding, among);
          return t && takes(t, s.durationSeconds)
            ? [{ personId: t.personId, score: t.score, turnIndex: s.turnIndex }]
            : [];
        })
      : [];
  return {
    margin: best?.margin ?? null,
    personId,
    score: best?.score ?? null,
    turns,
    vector,
  };
}
