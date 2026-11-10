// What a summary run reads of one conversation (intelligence.ts): its turns numbered, each
// speaker a token with a legend, the signals the chapters call is told (silences, travel), and
// the owner's people.

import type { Db } from "@lifelog/db";
import { locationHistory, people, type TurnRef } from "@lifelog/db/schema";
import { between } from "drizzle-orm";
import { distanceM } from "./places";
import { voiceId } from "./recognized-rows";
import type { SpeakerToken } from "./speaker-tokens";
import { loadTurns } from "./transcript";

// Faster than walking between two fixes is travelling; fixes less accurate are ignored.
const TRAVEL_KMH = 8;
const FIX_ACCURACY_M = 100;

interface Span {
  end: number | null;
  start: number | null;
}

export interface InputTurn {
  id: number;
  speaker: string;
  text: string;
  time: string | null;
}

export interface Input {
  languages: string[];
  // Where the owner starts or stops travelling during it (`travelChanges`). Not sent as such.
  moves: { at: number; travelling: boolean }[];
  // The owner's own person, when one is marked.
  owner: { aliases: string[]; name: string } | null;
  ownerTitle: string | null;
  // The owner's other people, whom an unnamed speaker may turn out to be.
  people: { aliases: string[]; id: string; name: string }[];
  refs: TurnRef[];
  // Each turn's capture start and end (epoch ms), when known. Not sent.
  spans: Span[];
  // What the legend says of each speaker token: "the owner", a person's name, or not
  // identified yet.
  speakers: Map<string, string>;
  // The voices each token stands for, as the run keeps them.
  tokens: SpeakerToken[];
  turns: InputTurn[];
  // Each token of a voice without a person, to its transcript speaker.
  unnamed: Map<string, { jobId: string; speakerLabel: string }>;
}

// One token per person and one per voice without a person, numbered in order of first
// appearance. A turn without a label is "someone". ponytail: a single-turn correction to a
// person adds its voice to that person's token.
function tokenize(
  turns: NonNullable<Awaited<ReturnType<typeof loadTurns>>>["turns"],
  ownerId: string | null
) {
  const byKey = new Map<string, string>();
  const speakers = new Map<string, string>();
  const voices = new Map<string, SpeakerToken>();
  const unnamed: Input["unnamed"] = new Map();
  const legend = (person: { id: string; name: string } | null) => {
    if (!person) {
      return "not identified yet";
    }
    return person.id === ownerId ? "the owner" : JSON.stringify(person.name);
  };
  const turnTokens = turns.map((t) => {
    if (!t.speakerLabel) {
      return "someone";
    }
    const voice = { jobId: t.ref.jobId, speakerLabel: t.speakerLabel };
    const key = t.person ? `person ${t.person.id}` : voiceOf(voice);
    const token = byKey.get(key) ?? `S${byKey.size + 1}`;
    if (!byKey.has(key)) {
      byKey.set(key, token);
      speakers.set(token, legend(t.person));
    }
    if (!voices.has(voiceOf(voice))) {
      voices.set(voiceOf(voice), { ...voice, token });
    }
    if (!t.person) {
      unnamed.set(token, voice);
    }
    return token;
  });
  return { speakers, tokens: [...voices.values()], turnTokens, unnamed };
}

// The conversation's transcript as numbered turns: those before the first job still being
// transcribed. Null without any.
export function loadInput(db: Db, conversationId: string): Input | null {
  const loaded = loadTurns(db, conversationId);
  if (!loaded) {
    return null;
  }
  const { pendingFrom } = loaded;
  const heard =
    pendingFrom === null
      ? loaded.turns
      : loaded.turns.filter(
          (t) => Date.parse(t.ref.capturedAt ?? "") < pendingFrom
        );
  if (heard.length === 0) {
    return null;
  }
  const spans = heard.map((t) => ({
    end: t.endedAt ? Date.parse(t.endedAt) : null,
    start: t.ref.capturedAt ? Date.parse(t.ref.capturedAt) : null,
  }));
  const everyone = db.select().from(people).orderBy(people.name).all();
  const fixes = db
    .select()
    .from(locationHistory)
    .where(
      between(
        locationHistory.observedAt,
        new Date(loaded.range[0]),
        new Date(loaded.range[1])
      )
    )
    .orderBy(locationHistory.observedAt)
    .all();
  const owner = everyone.find((p) => p.isOwner);
  const { speakers, tokens, turnTokens, unnamed } = tokenize(
    heard,
    owner?.id ?? null
  );
  return {
    languages: loaded.languages,
    moves: travelChanges(
      fixes.map((f) => ({ ...f, at: f.observedAt.getTime() }))
    ),
    owner: owner ?? null,
    ownerTitle: loaded.ownerTitle,
    people: everyone
      .filter((p) => !p.isOwner)
      .map((p) => ({ aliases: p.aliases, id: p.id, name: p.name })),
    refs: heard.map((t) => t.ref),
    spans,
    speakers,
    tokens,
    turns: heard.map((t, id) => ({
      id,
      speaker: turnTokens[id] ?? "someone",
      text: t.text,
      time: t.ref.capturedAt,
    })),
    unnamed,
  };
}

// Consecutive turns, each window under maxChars of turn text unless one turn alone is
// longer. ponytail: a single turn longer than a window is sent whole, not split.
export function windows(turns: InputTurn[], maxChars: number) {
  const out: [number, number][] = [];
  let size = 0;
  for (const turn of turns) {
    const current = out.at(-1);
    const { length } = JSON.stringify(turn);
    if (current && size + length <= maxChars) {
      current[1] = turn.id;
      size += length;
    } else {
      out.push([turn.id, turn.id]);
      size = length;
    }
  }
  return out;
}

// Where the owner starts or stops travelling (faster than walking between two accurate fixes),
// from fixes in time order. The first fix only sets where things stand.
export function travelChanges(
  fixes: {
    accuracyM: number;
    at: number;
    latitude: number;
    longitude: number;
  }[]
) {
  const out: { at: number; travelling: boolean }[] = [];
  const kept = fixes.filter((f) => f.accuracyM <= FIX_ACCURACY_M);
  let was: boolean | null = null;
  for (const [i, f] of kept.entries()) {
    const g = kept[i + 1];
    if (!g || g.at <= f.at) {
      continue;
    }
    const travelling = (distanceM(f, g) / (g.at - f.at)) * 3600 > TRAVEL_KMH;
    if (was !== null && travelling !== was) {
      out.push({ at: f.at, travelling });
    }
    was = travelling;
  }
  return out;
}

export const voiceOf = (v: Omit<SpeakerToken, "token">) =>
  voiceId(v.jobId, v.speakerLabel);

// Each of the input's own tokens to the one `theirs` gives its voice, else a number after
// theirs.
function renaming(input: Input, theirs: Map<string, string>) {
  const rename = new Map<string, string>();
  for (const v of input.tokens) {
    const token = theirs.get(voiceOf(v));
    if (token && !rename.has(v.token)) {
      rename.set(v.token, token);
    }
  }
  let next = Math.max(...[...theirs.values()].map((t) => Number(t.slice(1))));
  for (const token of input.speakers.keys()) {
    if (!rename.has(token)) {
      next += 1;
      rename.set(token, `S${next}`);
    }
  }
  return (token: string) => rename.get(token) ?? token;
}

// The input with the tokens of `tokens` (the run a piece is cut from), so the summaries cut
// from it read the same; its own voices that run never heard are numbered after.
export function adopt(input: Input, tokens: SpeakerToken[] | undefined): Input {
  if (!tokens?.length) {
    return input;
  }
  const theirs = new Map(tokens.map((v) => [voiceOf(v), v.token]));
  const to = renaming(input, theirs);
  const speakers = new Map(
    [...input.speakers].map(([token, who]) => [to(token), who])
  );
  for (const { token } of tokens) {
    if (!speakers.has(token)) {
      speakers.set(token, "speaks only in the rest of the recording");
    }
  }
  return {
    ...input,
    speakers,
    tokens: [
      ...tokens,
      ...input.tokens
        .filter((v) => !theirs.has(voiceOf(v)))
        .map((v) => ({ ...v, token: to(v.token) })),
    ],
    turns: input.turns.map((t) => ({ ...t, speaker: to(t.speaker) })),
    unnamed: new Map([...input.unnamed].map(([t, v]) => [to(t), v])),
  };
}
