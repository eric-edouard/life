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
import { NAMING, RECOGNITION } from "./config";
import { averageLinkageSync } from "./voice-linkage";

import { cosine, type Vector } from "./voice-vectors";

// A person's voice: one centroid per conversation of their evidence (people.ts `weighProfiles`).
export interface Profile {
  conversations: string[];
  exemplars: Vector[];
  isOwner: boolean;
  personId: string;
}

// One embedding model's voices: each person's profile, and one centroid per conversation of the
// strangers' (people.ts `weighProfiles`).
export interface Profiles {
  people: Profile[];
  strangerConversations: string[];
  strangers: Vector[];
}
export const NO_PROFILES: Profiles = {
  people: [],
  strangerConversations: [],
  strangers: [],
};

// Each centroid belongs to one conversation; filtering never changes its vector or order.
export function profilesWithout(
  profiles: Profiles,
  excluded: Set<string>
): Profiles {
  const without = (exemplars: Vector[], conversations: string[]) => ({
    conversations: conversations.filter((id) => !excluded.has(id)),
    exemplars: exemplars.filter(
      (_, i) => !excluded.has(conversations[i] ?? "")
    ),
  });
  const strangers = without(profiles.strangers, profiles.strangerConversations);
  return {
    people: profiles.people.flatMap((p) => {
      const kept = without(p.exemplars, p.conversations);
      return kept.exemplars.length ? [{ ...p, ...kept }] : [];
    }),
    strangerConversations: strangers.conversations,
    strangers: strangers.exemplars,
  };
}

function unit(v: Vector): Vector {
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

// One exemplar per conversation: the centroid of its clips.
export const exemplarsOf = (
  clips: { conversationId: string; embedding: Vector }[]
) => {
  const grouped = Map.groupBy(clips, (r) => r.conversationId);
  return {
    conversations: [...grouped.keys()],
    exemplars: [...grouped.values()].map((c) =>
      centroid(c.map((r) => r.embedding))
    ),
  };
};

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

// A voice he named that sounds like someone else (a recheck): the share of its turns whose first
// guess is another person, and that person, once the share reaches `NAMING.recheckShare`. Null
// when the named person has no evidence elsewhere: nothing to compare with.
export function soundsLikeOf(
  vectors: Vector[],
  namedPersonId: string,
  profiles: Profile[]
) {
  if (!(vectors.length && profiles.some((p) => p.personId === namedPersonId))) {
    return null;
  }
  const others = vectors.flatMap((v) => {
    const personId = rankPeople(v, profiles)[0]?.personId;
    return personId && personId !== namedPersonId ? [personId] : [];
  });
  const share = others.length / vectors.length;
  const [personId] = [...Map.groupBy(others, (id) => id)]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([id]) => id);
  return personId && share >= NAMING.recheckShare ? { personId, share } : null;
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

// Who a speaker's voice is: its nearest person, at the bar's likeness and lead over the next
// (the ordinary one, or a short voice's), unless it sounds more like the strangers (`isStranger`).
const ORDINARY: { margin: number; threshold: number } = {
  margin: RECOGNITION.margin,
  threshold: RECOGNITION.matchThreshold,
};
function nameOf(
  vector: Vector,
  { strangers, people }: Profiles,
  bar = ORDINARY
) {
  const best = nearest(vector, people);
  const matched =
    best && best.score >= bar.threshold && best.margin >= bar.margin
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

// A voice under `minSpeakerSeconds` (samples, no vector) is compared at the short bar, for a
// person only: `nameOf`'s `isStranger` is not used (it stays unnamed, never marked stranger),
// and its `vector` stays null, so it is no nearby reference and joins no unnamed group.
function shortNameOf(
  samples: { embedding: Vector }[],
  vector: Vector | null,
  voices: Profiles,
  candidates?: Candidates | null
) {
  return !(vector || candidates) && samples.length > 0
    ? nameOf(centroid(samples.map((s) => s.embedding)), voices, {
        margin: RECOGNITION.shortVoiceMargin,
        threshold: RECOGNITION.shortVoiceThreshold,
      })
    : null;
}

// The person whose nearby voice is most like `r`, if alike enough and ahead of anyone else's.
export function nearbyPerson(
  r: { model: string | null; vector: Vector | null },
  nearby: { model: string; personId: string; vector: Vector }[]
) {
  const scores = nearby
    .filter((n) => n.model === r.model)
    .map((n) => ({
      personId: n.personId,
      score: cosine(n.vector, r.vector ?? []),
    }))
    .sort((a, b) => b.score - a.score);
  const [best] = scores;
  const runnerUp = scores.find((s) => s.personId !== best?.personId);
  return best &&
    best.score >= RECOGNITION.nearbyVoice &&
    best.score - (runnerUp?.score ?? 0) >= RECOGNITION.margin
    ? best.personId
    : null;
}

// A voice whose clean samples all left for turn rows: named at the short bar from the samples of
// the turns recognition moved. A person only: no turns, no vector (it is no reference), no group.
export const movedVoice = (
  samples: { embedding: Vector }[],
  voices: Profiles
) => {
  const named = shortNameOf(samples, null, voices);
  return {
    isStranger: false,
    margin: named?.best?.margin ?? null,
    model: null,
    personId: named?.personId ?? null,
    score: named?.best?.score ?? null,
    turns: [],
    vector: null,
  };
};

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
  const heard = named ?? shortNameOf(samples, vector, voices, candidates);
  const personId = heard?.personId ?? null;
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
    margin: heard?.best?.margin ?? null,
    personId,
    score: heard?.best?.score ?? null,
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
