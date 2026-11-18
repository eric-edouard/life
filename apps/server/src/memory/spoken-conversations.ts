import { CONVERSATION_ENDS_AFTER } from "../core/quiet";
import { authorOf, type LifelogTurn, turnRef } from "../sources/lifelog";
import { voiceKey } from "../sources/lifelog-voices";
import { exchangesOf, isFinished } from "./exchanges";
import { OWNER } from "./read-truth";
import { voiceUnitId } from "./unit-ids";
import { turnKey, unnamedTurnKey, voiceTokensOf } from "./units";
import type { People } from "./who";
import { isTalkingWithOwner, messageLine, turnLines } from "./words";
import { localDate, time } from "./zones";

// The spoken conversations (docs/glossary.md): the owner's recorded speech cut where nobody speaks for
// `CONVERSATION_ENDS_AFTER`, whoever was there, and the parts a long one is read in. Cut by code from lifelog's turns
// (their words fetched when read), never stored.

/** A conversation of at least this many characters, with someone else talking, gets a summary. */
export const SUMMARY_FROM_CHARS = 15_000;
/** A part holds at most this many characters: a longer conversation is cut at its longest silence. */
export const CONVERSATION_PART_CHARS = 150_000;

/** A recorded turn and the lifelog conversation it is in (`readSpokenTurns`). */
export type SpokenTurn = LifelogTurn & { conversation: string };

/** The spoken conversations among `turns` that are over as of `now` (`isFinished`), oldest first. */
export const spokenConversationsOf = (turns: SpokenTurn[], now: Date) =>
  exchangesOf(turns, CONVERSATION_ENDS_AFTER).filter((c) =>
    isFinished(c, now, CONVERSATION_ENDS_AFTER)
  );

/** One line of a part as lifelog has it: who spoke it, which voice of its recording, and the words. */
export interface SpokenVoice {
  /** The lifelog person id (else the name) that named it, as `authorOf`; null for him or a voice nobody named. */
  from: string | null;
  /** The voice's label in its recording (`voiceKey`). */
  label: string;
  /** The name lifelog gave it, as the directory names it now; null for him or a voice nobody named. */
  name: string | null;
  owner: boolean;
  text: string;
  time: string;
}

/** One call's worth of a conversation: its lines `[n] HH:MM who: text` from 0, and the key of each turn they are. */
export interface SpokenPart {
  at: string;
  chars: number;
  day: string;
  keys: string[];
  lines: string[];
  /** The named people (other than him) whose turns are in it, by name. */
  people: string[];
  /** Its first turn's ref: what opens it (`fetch person:me/conversation/<ref>`). */
  ref: string;
  /** The conversation-days its turns are in (`voiceUnitId`): what it reads, as a call's `reads` count. */
  units: string[];
  /** When its last turn ended. */
  until: string;
  /** What each line is made of, in order: `lines` are made from these. */
  voices: SpokenVoice[];
}

/** A line of a part: `[n] HH:MM who: text`. */
export const partLine = (n: number, v: SpokenVoice, who: string) =>
  `[${n}] ${messageLine(v.time, who, v.text)}`;

/** The line in [from, to) with the longest silence before it, or -1 when there is none. */
function widest(gaps: number[], from: number, to: number) {
  let best = -1;
  for (let k = from; k < to; k += 1) {
    if (best < 0 || (gaps[k] ?? 0) > (gaps[best] ?? 0)) {
      best = k;
    }
  }
  return best;
}

/** Where the part of lines of these `sizes` starting at `from` ends: the longest silence in its second half, else the longest anywhere in it, else where the next line no longer fits. */
function partEnd(sizes: number[], gaps: number[], from: number) {
  let [size, i, half] = [0, from, from + 1];
  while (
    i < sizes.length &&
    size + (sizes[i] ?? 0) <= CONVERSATION_PART_CHARS
  ) {
    size += sizes[i] ?? 0;
    i += 1;
    if (size < CONVERSATION_PART_CHARS / 2) {
      half = i + 1;
    }
  }
  if (i >= sizes.length) {
    return sizes.length;
  }
  const late = widest(gaps, half, i);
  const cut = late >= 0 ? late : widest(gaps, from + 1, i);
  return cut >= 0 ? cut : Math.max(i, from + 1);
}

/** Where each part of these lines ends (`partEnd`). */
function cutsOf(sizes: number[], gaps: number[]) {
  const ends: number[] = [];
  for (let from = 0; from < sizes.length; from = ends.at(-1) ?? 0) {
    ends.push(partEnd(sizes, gaps, from));
  }
  return ends;
}

/**
 * The parts a spoken conversation is read in, or none when it does not qualify (under `SUMMARY_FROM_CHARS`, or no
 * line but his). Its words are fetched from lifelog (`turnLines`): a voice lifelog heard from a screen, nearby or as an
 * announcement is left out, one it never classified or heard over a phone is kept. A voice no one named is `V1`, `V2`… by its
 * first line (distinct per recording and label); a failed fetch throws.
 */
export async function spokenPartsOf(
  conversation: SpokenTurn[],
  people: Pick<People, "nameOf" | "resolve">
): Promise<SpokenPart[]> {
  const byRef = new Map(
    conversation.map((t) => [turnRef(t.jobId, t.turnIndex, t.at), t])
  );
  const spoken = await turnLines(
    new Map([["c", conversation]]),
    [...new Set(conversation.map((t) => t.conversation))],
    people.resolve,
    isTalkingWithOwner
  );
  const heard = (spoken.get("c") ?? []).flatMap((l) => {
    const t = byRef.get(l.ref);
    return t ? [{ l, t }] : [];
  });
  const label = (l: { voice?: string }) => l.voice ?? "speaker";
  // A voice no one named is V1, V2… by its first line, one numbering over the whole conversation.
  const tokens = voiceTokensOf(
    heard
      .filter(({ t }) => !(t.owner || t.name))
      .map(({ l }) => unnamedTurnKey(l.ref, label(l)))
  );
  let silent = Number.NEGATIVE_INFINITY;
  const shown = heard.map(({ l, t }) => {
    const unnamed = !(t.owner || t.name);
    let who = "me";
    if (!t.owner && t.name) {
      who = people.nameOf(l.speaker);
    } else if (unnamed) {
      who = tokens.get(voiceKey(t.jobId, label(l))) ?? "";
    }
    const gap = Date.parse(t.at) - silent;
    silent = Math.max(silent, Date.parse(t.end ?? t.at));
    const voice: SpokenVoice = {
      from: authorOf(t),
      label: label(l),
      name: !t.owner && t.name ? who : null,
      owner: t.owner,
      text: l.text,
      time: time(t.at),
    };
    return {
      gap,
      key: turnKey(t),
      ref: l.ref,
      size: messageLine(voice.time, who, voice.text).length + 1,
      speaker: l.speaker,
      t,
      voice,
      who,
    };
  });
  const chars = shown.reduce((n, s) => n + s.size, 0);
  if (chars < SUMMARY_FROM_CHARS || shown.every((s) => s.speaker === OWNER)) {
    return [];
  }
  let from = 0;
  return cutsOf(
    shown.map((s) => s.size),
    shown.map((s) => s.gap)
  ).map((to) => {
    const part = shown.slice(from, to);
    from = to;
    const [first] = part;
    return {
      at: first?.t.at ?? "",
      chars: part.reduce((n, s) => n + s.size, 0),
      day: localDate(first?.t.at ?? ""),
      keys: part.map((s) => s.key),
      lines: part.map((s, n) => partLine(n, s.voice, s.who)),
      people: [...new Set(part.flatMap((s) => s.voice.name || []))],
      ref: first?.ref ?? "",
      units: [
        ...new Set(
          part.map((s) => voiceUnitId(s.t.conversation, localDate(s.t.at)))
        ),
      ],
      until: new Date(
        Math.max(...part.map((s) => Date.parse(s.t.end ?? s.t.at)))
      ).toISOString(),
      voices: part.map((s) => s.voice),
    };
  });
}
