// Who spoke each turn (docs/processing.md, "Speakers"), in two steps:
// - a speaker's clean turns together are the person their voice matches: `likeness` at least
//   `matchThreshold` to the profile and `margin` ahead of the next person;
// - a turn whose own voice is nearest the owner's, at `ownerTurn` or more, is his, whoever the
//   speaker is. The provider often puts him and someone else under one speaker. A turn under
//   `shortTurnSeconds` needs only `ownerShortTurn` when it is also `margin` ahead of the next person.
// A voice the owner said is several people is no one: each turn is decided among his candidates.
// A name, or a turn moved to someone, is refused when the voice sounds more like the voices he
// answered "don't know" for than like that person (`dontKnowLead`).
// Measured on the owner's corrections, this is as good as the label rules it replaced on other
// people and better on the owner. The caller leaves out what the owner answered: his answers win.

import type { Candidates } from "@lifelog/db/schema";
import { RECOGNITION } from "./config";

export type Vector = number[];

// A person's voice: one centroid per conversation of their evidence (people.ts `weighProfiles`).
export interface Profile {
  exemplars: Vector[];
  isOwner: boolean;
  personId: string;
}

// One embedding model's voices: each person's profile, and one centroid per conversation of the
// voices the owner answered "don't know" for (people.ts `weighProfiles`).
export interface Voices {
  dontKnow: Vector[];
  people: Profile[];
}
export const NO_VOICES: Voices = { dontKnow: [], people: [] };

// Embeddings are L2-normalized, so the dot product is the cosine.
export const cosine = (a: Vector, b: Vector) =>
  a.reduce((sum, x, i) => sum + x * (b[i] ?? 0), 0);

function unit(v: Vector): Vector {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

export const centroid = (vectors: Vector[]): Vector =>
  unit(vectors.reduce((acc, v) => acc.map((x, i) => x + (v[i] ?? 0))));

// How much a voice sounds like a person: its mean cosine to the `bestExemplars` closest of their
// exemplars (`Profile`). One voice sounds different by room, microphone and call; a single centroid
// blurs a phone voice into the room it was learned in.
export function likeness(vector: Vector, exemplars: Vector[]) {
  const top = exemplars
    .map((e) => cosine(vector, e))
    .sort((a, b) => b - a)
    .slice(0, RECOGNITION.bestExemplars);
  return top.reduce((sum, x) => sum + x, 0) / (top.length || 1);
}

// The person a voice sounds most like, and its lead over the next one. With a single profile the
// runner-up counts as 0: unrelated voices score near 0 with ECAPA.
function nearest(vector: Vector, profiles: Profile[]) {
  const [best, next] = profiles
    .map((p) => ({ ...p, score: likeness(vector, p.exemplars) }))
    .sort((a, b) => b.score - a.score);
  return best ? { ...best, margin: best.score - (next?.score ?? 0) } : null;
}

// The person a voice refused for its margin is, decided among the people named nearby
// (people.ts `nameFromNearby`): its nearest person when they are one of them, at `matchThreshold`,
// and `nearbyMargin` ahead of the next of them. Two people who sound alike are rarely both around.
export function nearbyMatch(
  vector: Vector,
  profiles: Profile[],
  nearbyPeople: Set<string>
) {
  const best = nearest(vector, profiles);
  const among = nearest(
    vector,
    profiles.filter((p) => nearbyPeople.has(p.personId))
  );
  return best &&
    best.personId === among?.personId &&
    best.score >= RECOGNITION.matchThreshold &&
    among.margin >= RECOGNITION.nearbyMargin
    ? best.personId
    : null;
}

// Whether a voice is `dontKnowLead` more like the voices he answered "don't know" for than the
// `score` of its match.
const soundsUnknownTo = (dontKnow: Vector[], v: Vector, score: number) =>
  dontKnow.length > 0 &&
  likeness(v, dontKnow) > score + RECOGNITION.dontKnowLead;

// Who a speaker's voice is: its nearest person, at `matchThreshold` and `margin` ahead of the
// next, unless it sounds more like a voice he doesn't know (`soundsUnknown`).
function nameOf(vector: Vector, { dontKnow, people }: Voices) {
  const best = nearest(vector, people);
  const matched =
    best &&
    best.score >= RECOGNITION.matchThreshold &&
    best.margin >= RECOGNITION.margin
      ? best
      : null;
  const soundsUnknown =
    !!matched && soundsUnknownTo(dontKnow, vector, matched.score);
  return {
    best,
    personId: matched && !soundsUnknown ? matched.personId : null,
    soundsUnknown,
  };
}

// One speaker of a transcript: who its voice is (null when below the threshold or not ahead
// enough), and the turns that are someone else's: the owner's, or each one's among `candidates`.
// `samples` are its clean turns of one embedding model, `vector` their voice (null with too little
// speech; people.ts `speakerVoice`), `voices` that model's. Among his candidates, nothing is
// refused for sounding unknown: he said who is there.
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
  voices: Voices,
  candidates?: Candidates | null
) {
  const profiles = voices.people;
  const owner = profiles.find((p) => p.isOwner)?.personId;
  const named = vector && !candidates ? nameOf(vector, voices) : null;
  const personId = named?.personId ?? null;
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
          return t &&
            takes(t, s.durationSeconds) &&
            !(
              !candidates &&
              soundsUnknownTo(voices.dontKnow, s.embedding, t.score)
            )
            ? [{ personId: t.personId, score: t.score, turnIndex: s.turnIndex }]
            : [];
        })
      : [];
  return {
    margin: named?.best?.margin ?? null,
    personId,
    score: named?.best?.score ?? null,
    soundsUnknown: named?.soundsUnknown ?? false,
    turns,
    vector,
  };
}
