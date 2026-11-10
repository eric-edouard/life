// Who spoke each turn (docs/processing.md, "Speakers"), in two steps:
// - a speaker's clean turns together are the person their voice matches: `likeness` at least
//   `matchThreshold` to the profile and `margin` ahead of the next person;
// - a turn whose own voice is nearest the owner's, at `ownerTurn` or more, is his, whoever the
//   speaker is. The provider often puts him and someone else under one speaker. A turn under
//   `shortTurnSeconds` needs only `ownerShortTurn` when it is also `margin` ahead of the next person.
// A voice the owner said is several people is no one: each turn is decided among his candidates.
// A voice that sounds more like the strangers (voices he answered "Not anyone I know" for, people he
// doesn't care about) than like its nearest person, and as like them as an unnamed group's voices
// are alike, is a stranger too: no name (`strangerLead`, `candidateThreshold`). A turn more like
// them than like its nearest person is not moved.
// Measured on the owner's corrections, this is as good as the label rules it replaced on other
// people and better on the owner. The caller leaves out what the owner answered: his answers win.

import type { Candidates } from "@lifelog/db/schema";
import { RECOGNITION } from "./config";
import { averageLinkageSync } from "./voice-linkage";

import { cosine, type Vector } from "./voice-vectors";

// A person's voice: one centroid per conversation of their evidence (people.ts `weighProfiles`).
export interface Profile {
  exemplars: Vector[];
  isOwner: boolean;
  personId: string;
}

// One embedding model's voices: each person's profile, and one centroid per conversation of the
// strangers' (people.ts `weighProfiles`).
export interface Profiles {
  people: Profile[];
  strangers: Vector[];
}
export const NO_PROFILES: Profiles = { people: [], strangers: [] };

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

// Everyone by likeness and lead over the strongest other person; a lone profile competes
// with the match threshold so a thin profile cannot name a weak match by default.
export function rankPeople(vector: Vector, profiles: Profile[]) {
  const ranked = profiles
    .map((p) => ({ ...p, score: likeness(vector, p.exemplars) }))
    .sort((a, b) => b.score - a.score);
  return ranked.map((person, i) => ({
    ...person,
    margin:
      person.score -
      (ranked[i === 0 ? 1 : 0]?.score ?? RECOGNITION.matchThreshold),
  }));
}

const nearest = (vector: Vector, profiles: Profile[]) =>
  rankPeople(vector, profiles)[0] ?? null;

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

// Whether a voice is `strangerLead` more like the strangers than the `score` of its match.
const isMoreLikeStrangers = (strangers: Vector[], v: Vector, score: number) =>
  strangers.length > 0 &&
  likeness(v, strangers) > score + RECOGNITION.strangerLead;

// Who a speaker's voice is: its nearest person, at `matchThreshold` and `margin` ahead of the
// next, unless it sounds more like the strangers (`isStranger`).
function nameOf(vector: Vector, { strangers, people }: Profiles) {
  const best = nearest(vector, people);
  const matched =
    best &&
    best.score >= RECOGNITION.matchThreshold &&
    best.margin >= RECOGNITION.margin
      ? best
      : null;
  // Weighed for a voice that missed too, so the nearby step leaves it alone. A stranger is as like
  // them as an unnamed group's voices are alike: a new voice unlike everyone still gets asked about.
  const isStranger =
    !!best &&
    isMoreLikeStrangers(
      strangers,
      vector,
      Math.max(
        best.score,
        RECOGNITION.candidateThreshold - RECOGNITION.strangerLead
      )
    );
  return {
    best,
    isStranger,
    personId: matched && !isStranger ? matched.personId : null,
  };
}

// One speaker of a transcript: who its voice is (null when below the threshold or not ahead
// enough), and the turns that are someone else's: the owner's, or each one's among `candidates`.
// `samples` are its clean turns of one embedding model, `vector` their voice (null with too little
// speech; people.ts `speakerVoice`), `voices` that model's. Among his candidates, nothing is
// refused for sounding like a stranger: he said who is there.
function decisionOf(
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
  voices: Profiles,
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
    candidates || owner
      ? samples.flatMap((s) => {
          const t = nearest(s.embedding, among);
          return t &&
            takes(t, s.durationSeconds) &&
            (candidates ||
              !isMoreLikeStrangers(voices.strangers, s.embedding, t.score))
            ? [{ personId: t.personId, score: t.score, turnIndex: s.turnIndex }]
            : [];
        })
      : [];
  return {
    isStranger: named?.isStranger ?? false,
    margin: named?.best?.margin ?? null,
    personId,
    score: named?.best?.score ?? null,
    turns,
    vector,
  };
}

// A split needs repeated, strongly separated speech; unsampled turns keep the label.
export function decide(
  voice: Parameters<typeof decisionOf>[0],
  profiles: Profiles,
  candidates?: Candidates | null
) {
  const initial = decisionOf(voice, profiles, candidates);
  interface Turn {
    personId: string | null;
    score: number | null;
    turnIndex: number;
    voice?: ReturnType<typeof decisionOf>;
  }
  const turns: Turn[] = initial.turns;
  if (candidates) {
    return { ...initial, turns };
  }
  // His own turns leave first, before the remaining voice is grouped.
  const moved = new Set(turns.map((t) => t.turnIndex));
  const remaining = voice.samples.filter((s) => !moved.has(s.turnIndex));
  const groups = averageLinkageSync(
    remaining.map((s) => s.embedding),
    RECOGNITION.candidateThreshold
  )
    .map((indices) => {
      const samples = indices.flatMap((i) => remaining[i] ?? []);
      return {
        samples,
        seconds: samples.reduce((sum, s) => sum + s.durationSeconds, 0),
        vector: centroid(samples.map((s) => s.embedding)),
      };
    })
    .sort((a, b) => b.seconds - a.seconds);
  if (
    groups.length < 2 ||
    groups.some(
      (g, i) =>
        g.samples.length < 2 ||
        g.seconds < RECOGNITION.minSpeakerSeconds ||
        groups
          .slice(i + 1)
          .some((other) => cosine(g.vector, other.vector) > RECOGNITION.notThem)
    )
  ) {
    return { ...initial, turns };
  }
  const [main, ...others] = groups;
  for (const group of others) {
    const reading = decisionOf(group, profiles);
    turns.push(
      ...group.samples.map((s) => ({
        personId: reading.personId,
        score: reading.score,
        turnIndex: s.turnIndex,
        voice: reading,
      }))
    );
  }
  return { ...decisionOf(main ?? voice, profiles), turns };
}

// A model reading names only its checked scope; it is never profile evidence.
export interface InferredReading {
  confidence: number;
  evidence: { quote: string; turn: number }[];
  personId: string | null;
}

export interface NamingCalibration {
  confidence: number;
  contradictionMargin: number;
  contradictionScore: number;
}

function isSupportedReading(
  reading: InferredReading,
  cutoff: NamingCalibration,
  candidates?: Candidates | null
) {
  return (
    Object.values(cutoff).every(Number.isFinite) &&
    Number.isFinite(reading.confidence) &&
    reading.confidence >= 0 &&
    reading.confidence >= cutoff.confidence &&
    reading.confidence <= 1 &&
    reading.evidence.length > 0 &&
    (!candidates ||
      (!!reading.personId && candidates.people.includes(reading.personId)))
  );
}

// Applied after the ordinary voice and nearby decisions, with the owner's fixed turns removed.
export function decideInferredName(
  result: {
    isStranger: boolean;
    personId: string | null;
    vector: Vector | null;
  },
  profiles: Profiles,
  reading: InferredReading,
  context: {
    calibration: NamingCalibration | null;
    candidates?: Candidates | null;
  }
) {
  if (result.personId || result.isStranger) {
    return result.personId;
  }
  const cutoff = context.calibration;
  if (
    !(
      cutoff &&
      reading.personId &&
      isSupportedReading(reading, cutoff, context.candidates)
    )
  ) {
    return null;
  }
  const best = result.vector
    ? rankPeople(result.vector, profiles.people)[0]
    : null;
  if (
    best &&
    best.personId !== reading.personId &&
    best.score >= cutoff.contradictionScore &&
    best.margin >= cutoff.contradictionMargin
  ) {
    return null;
  }
  return reading.personId;
}
