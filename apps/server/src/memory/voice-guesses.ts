import { settings } from "../core/settings";
import { NamedVoice, type ReadReply } from "../records/read-reply";
import {
  type NamingQueueItem,
  readJobMonths,
  readVoiceNames,
  voiceKey,
} from "../sources/lifelog-voices";
import { READ_REPLIES } from "./memory-files";
import { readReplies, readRepliesOfMonths } from "./read-replies";
import { UNKNOWN, unnamedTurnKey, voiceOfKey, voiceTokensOf } from "./units";
import type { People } from "./who";

// The voice guesses (docs/glossary.md, "voice guess"): what the voice naming stored (`memory/voice-naming.ts`), read as
// a guess for each turn nobody named. A guess is only ever shown: as "probably X" when the words of a conversation are
// opened (`fetch`, behind his `voiceGuessesShown` setting), and as a voice card's question, "Is this X?", when lifelog's
// suggestion does not contradict it (`withVoiceGuesses`, who.ts `voiceSuggestionOf`). Nothing here names a turn: it never sets a speaker, reaches
// lifelog, makes or folds a person or touches a line any step reads, and these files never import `forward` or the
// corrections (`scripts/imports.test.ts` checks).

/** A guess for one voice of one part, as stored. `keys` are the `unnamedTurnKey`s of its turns in the part. */
export interface VoiceGuess {
  at: string;
  confidence: "sure" | "likely" | "weak";
  keys: string[];
  /** An offered person ref, `me` or `unknown`. */
  person: string;
  /** The voice: its recording and label (`voiceOfKey`). */
  voice: string;
}

/**
 * The guesses a stored line holds that still check against its own keys: an entry is dropped when a line it cites is
 * absent or is not a turn of its voice, as `voiceTokensOf` numbers the voices of the keys no one had named.
 */
export function voiceGuessesOf(line: ReadReply): VoiceGuess[] {
  if (line.read !== "voice_naming") {
    return [];
  }
  const unnamed = line.messages.map((k) => (k.includes(" voice:") ? k : ""));
  const tokens = voiceTokensOf(unnamed.filter(Boolean));
  const tokenOf = (n: number) => {
    const key = unnamed[n];
    return key ? tokens.get(voiceOfKey(key)) : undefined;
  };
  return line.reply.voices.flatMap((v) => {
    const e = NamedVoice.safeParse(v).data;
    if (!e) {
      return [];
    }
    const keys = [...new Set(unnamed.filter((_, n) => tokenOf(n) === e.voice))];
    return keys.length > 0 && e.lines.every((n) => tokenOf(n) === e.voice)
      ? [
          {
            at: line.at,
            confidence: e.confidence,
            keys,
            person: e.person,
            voice: voiceOfKey(keys[0] as string),
          },
        ]
      : [];
  });
}

/**
 * The newest guess of each unnamed turn key in `lines`, of any version of the voice naming's prompt: a guess an older
 * prompt made stays one until a newer line replaces it (a prompt's bump re-asks only the night's window).
 */
function newestGuessesOf(lines: readonly ReadReply[]) {
  const now = new Map<string, VoiceGuess>();
  for (const g of lines.flatMap(voiceGuessesOf)) {
    for (const key of g.keys) {
      if ((now.get(key)?.at ?? "") <= g.at) {
        now.set(key, g);
      }
    }
  }
  return now;
}

/** Each month file's newest guesses, by its lines as `readAppended` keeps them: worked out again only when the file grew. */
const guessesOfFile = new WeakMap<
  readonly ReadReply[],
  Map<string, VoiceGuess>
>();

/** The newest stored guess of each unnamed turn key in these month files, a file's worked out again only when it grew. */
function newestOfFiles(files: readonly (readonly ReadReply[])[]) {
  const now = new Map<string, VoiceGuess>();
  for (const lines of files) {
    const held = guessesOfFile.get(lines) ?? newestGuessesOf(lines);
    guessesOfFile.set(lines, held);
    for (const [key, g] of held) {
      if ((now.get(key)?.at ?? "") <= g.at) {
        now.set(key, g);
      }
    }
  }
  return now;
}

/**
 * The newest stored guess of each unnamed turn key (`unnamedTurnKey`), from the lines of any version of the voice
 * naming's prompt. The newest guess of a key whose person is not known today (`me` and `unknown` aside) leaves the key with none. A key is a turn's only while the turn
 * is still unnamed: a turn named since (his answer, lifelog's match, a relabel) has another key and is never looked up.
 */
export function voiceGuessesNow(
  people: Pick<People, "names" | "refOf">,
  where = READ_REPLIES
) {
  const now = newestOfFiles(readReplies(where));
  // The newest guess of a key is the one that counts: when its person is not known today the key has none, never an older guess.
  for (const [key, g] of now) {
    if (
      !(
        g.person === "me" ||
        g.person === "unknown" ||
        people.names.has(people.refOf(g.person))
      )
    ) {
      now.delete(key);
    }
  }
  return now;
}

/**
 * Who a turn is shown as when the words of a conversation are opened: its speaker, and "probably X" after it when it is a
 * turn nobody named (no author, speaker `unknown:`) and a sure or likely guess holds for its key now. Display only.
 */
const shownSpeaker = (
  line: { from?: string; ref: string; speaker: string; voice?: string },
  guesses: Map<string, VoiceGuess>,
  people: Pick<People, "nameOf">
) => {
  const g =
    line.speaker.startsWith(UNKNOWN) && !line.from
      ? guesses.get(unnamedTurnKey(line.ref, line.voice ?? "speaker"))
      : undefined;
  return g && g.person !== "unknown" && g.confidence !== "weak"
    ? `${line.speaker} (probably ${g.person === "me" ? "me" : people.nameOf(g.person)})`
    : line.speaker;
};

/** The lines `fetch` shows of recorded turns: with his `voiceGuessesShown` setting on, an unnamed speaker followed by "probably X". Off: the lines as they are. */
export function withGuessesShown<
  L extends { from?: string; ref: string; speaker: string; voice?: string },
>(
  lines: L[],
  people: Pick<People, "names" | "nameOf" | "refOf">,
  where = READ_REPLIES
) {
  if (!settings().voiceGuessesShown) {
    return lines;
  }
  const guesses = voiceGuessesNow(people, where);
  return lines.map((l) => ({
    ...l,
    speaker: shownSpeaker(l, guesses, people),
  }));
}

/** A queue item as a voice card reads it (`withVoiceGuesses`). */
export type GuessedQueueItem = NamingQueueItem & {
  guessed?: readonly string[];
  names?: Readonly<Record<string, string>>;
};

/**
 * Who each voice's turns are guessed to be, as a voice card reads them: over the newest guess of each unnamed turn key
 * (`newest`), the sure or likely ones naming someone (never `me` or `unknown`), each person once, sorted; for the voices
 * given. The score's by-group row reads the same (`scripts/voice-naming-score.ts`).
 */
export function voiceGuessedPeopleOf(
  newest: Iterable<Pick<VoiceGuess, "confidence" | "person" | "voice">>
) {
  const byVoice = Map.groupBy(
    [...newest].filter(
      (g) =>
        g.confidence !== "weak" && g.person !== "me" && g.person !== "unknown"
    ),
    (g) => g.voice
  );
  return (voices: readonly string[]) =>
    [
      ...new Set(
        voices.flatMap((v) => (byVoice.get(v) ?? []).map((g) => g.person))
      ),
    ].sort();
}

/**
 * Each queue item as a voice card reads it: with who the voice naming guessed its voices are (`guessed`, for
 * `voiceSuggestionOf`: `voiceGuessedPeopleOf` the newest guess of each of its turns, as stored) and the name lifelog gives each
 * of its person ids (`names`, `readVoiceNames`). Reads only the month files its voices' recordings can be filed under
 * (`readJobMonths`); throws when one cannot be read.
 */
export async function withVoiceGuesses<I extends NamingQueueItem>(
  items: readonly I[],
  where = READ_REPLIES,
  monthsOf = readJobMonths,
  namesOf: (
    ids: readonly string[]
  ) => Promise<Record<string, string>> = readVoiceNames
) {
  const jobs = [...new Set(items.flatMap((i) => i.voices.map((v) => v.jobId)))];
  const idsOf = (i: I) =>
    [i.personId, ...i.likely].filter((id): id is string => id !== null);
  const [guesses, names] = await Promise.all([
    jobs.length > 0
      ? monthsOf(jobs).then((m) => newestOfFiles(readRepliesOfMonths(m, where)))
      : new Map<string, VoiceGuess>(),
    namesOf([...new Set(items.flatMap(idsOf))]),
  ]);
  const guessedFor = voiceGuessedPeopleOf(guesses.values());
  return items.map((i) => ({
    ...i,
    guessed: guessedFor(i.voices.map((v) => voiceKey(v.jobId, v.speakerLabel))),
    // Each item's own ids only, so the inbox key (`checksKeyOf`) changes with them.
    names: Object.fromEntries(
      idsOf(i).flatMap((id) => (names[id] ? [[id, names[id]]] : []))
    ),
  }));
}
