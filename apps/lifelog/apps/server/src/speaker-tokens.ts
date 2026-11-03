// Speakers in summaries (prompt version 8 on). The model writes each speaker as a token such as
// {S2}, one per voice of the transcript; the run keeps which voices each token stands for. The
// text is rendered whenever it is read, with the name the transcript gives that voice now
// (transcript.ts `speakerNames`): a person's name, the owner's too, else "Speaker N". So naming a
// voice later fixes every summary at no cost. Cases: apps/server/fixtures/speaker-tokens.json.
import type { Db } from "@lifelog/db";
import { assignmentsByJob, speakerOf, voiceId } from "./people";
import { loadTurns, personOf } from "./transcript";

export interface SpeakerToken {
  jobId: string;
  speakerLabel: string;
  token: string;
}

const TOKEN = /\{(S\d+)\}('s)?/g;
const SENTENCE_START = /(^|[.!?]\s+)$/;

const capitalized = (word: string) =>
  word.charAt(0).toUpperCase() + word.slice(1);

// `text` with every token replaced by its speaker's name, capitalized at a sentence's start. A
// token without one reads "a speaker".
export function renderSpeakers(text: string, names: Record<string, string>) {
  let out = "";
  let at = 0;
  for (const match of text.matchAll(TOKEN)) {
    const [whole, token = "", possessive] = match;
    const name = names[token] ?? "a speaker";
    const word = possessive ? `${name}'s` : name;
    out += text.slice(at, match.index);
    out += SENTENCE_START.test(out) ? capitalized(word) : word;
    at = match.index + whole.length;
  }
  return out + text.slice(at);
}

// What each token of a conversation's run reads as: its voice's person, "a video" for media, else
// the name the conversation's transcript gives the voice. A voice no longer in it (a split moved
// it) is numbered after the transcript's.
export function tokenNames(
  db: Db,
  conversationId: string,
  tokens: SpeakerToken[]
): Record<string, string> {
  const loaded = loadTurns(db, conversationId);
  const byJob = assignmentsByJob(
    db,
    tokens.map((t) => t.jobId)
  );
  const shown = new Map<string, string>();
  for (const t of loaded?.turns ?? []) {
    const key = voiceId(t.ref.jobId, t.speakerLabel);
    if (!(t.person || shown.has(key))) {
      shown.set(key, t.speaker);
    }
  }
  let next = shown.size;
  const names: Record<string, string> = {};
  for (const [token, voices] of Map.groupBy(tokens, (t) => t.token)) {
    const rowsOf = voices.flatMap(
      (v) => speakerOf(byJob.get(v.jobId), v.speakerLabel, null) ?? []
    );
    const person = rowsOf.map(personOf).find(Boolean);
    const transcript = voices
      .map((v) => shown.get(voiceId(v.jobId, v.speakerLabel)))
      .find(Boolean);
    if (person) {
      names[token] = person.name;
    } else if (rowsOf.some((r) => r.status === "media")) {
      names[token] = "a video";
    } else if (transcript) {
      names[token] = transcript;
    } else {
      next += 1;
      names[token] = `Speaker ${next}`;
    }
  }
  return names;
}
