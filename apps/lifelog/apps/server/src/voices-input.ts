// What a run reads of one conversation (intelligence.ts): its turns numbered, each speaker a
// token with a legend, and the owner's people.

import type { Db } from "@lifelog/db";
import { people, type TurnRef } from "@lifelog/db/schema";
import { voiceId } from "./people";
import { loadTurns } from "./transcript";

export interface InputTurn {
  id: number;
  speaker: string;
  text: string;
  time: string | null;
}

export interface Input {
  languages: string[];
  // The owner's own person, when one is marked.
  owner: { aliases: string[]; name: string } | null;
  ownerTitle: string | null;
  // The owner's other people, whom an unnamed speaker may turn out to be.
  people: { aliases: string[]; id: string; name: string }[];
  refs: TurnRef[];
  // What the legend says of each speaker token: "the owner", a person's name, or not
  // identified yet.
  speakers: Map<string, string>;
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
    if (!t.person) {
      unnamed.set(token, voice);
    }
    return token;
  });
  return { speakers, turnTokens, unnamed };
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
  const everyone = db.select().from(people).orderBy(people.name).all();
  const owner = everyone.find((p) => p.isOwner);
  const { speakers, turnTokens, unnamed } = tokenize(heard, owner?.id ?? null);
  return {
    languages: loaded.languages,
    owner: owner ?? null,
    ownerTitle: loaded.ownerTitle,
    people: everyone
      .filter((p) => !p.isOwner)
      .map((p) => ({ aliases: p.aliases, id: p.id, name: p.name })),
    refs: heard.map((t) => t.ref),
    speakers,
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

export const voiceOf = (v: { jobId: string; speakerLabel: string }) =>
  voiceId(v.jobId, v.speakerLabel);
