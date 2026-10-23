// One error rate for every language: Latin and digit words count as one token each, Thai (written
// without spaces) one token per character. On English or French it is the word error rate, on
// Thai the character error rate, on mixed speech the mixed error rate of code-switching studies.
import type { Word } from "@life/voice-db/schema";
import type { Group, Pick } from "./sample";

export const THAI = /[\u0E00-\u0E7F]/;
const THAI_OR_NOT = /[\u0E00-\u0E7F]+|[^\u0E00-\u0E7F]+/g;
const JOINERS = /[’'`-]/g;
const SYMBOLS = /[^\p{L}\p{M}\p{N}\s]/gu;
const SPACES = /\s+/;
// Hesitations are left out and contractions spelled out, as usual for word error rates: Scribe
// writes every "euh" down and most models leave them out, which is no error of what was said.
const FILLERS = new Set([
  "euh",
  "heu",
  "hum",
  "hmm",
  "mm",
  "mhm",
  "uh",
  "uhm",
  "um",
  "umm",
]);
// A Map, not an object: a word like "constructor" would find the object's own properties.
const SPELLED = new Map([
  ["gonna", "going to"],
  ["gotta", "got to"],
  ["ok", "okay"],
  ["wanna", "want to"],
]);

// A stutter: a cut-off start of the next word ("en-entering"), dropped with its hyphen.
const FRAGMENT = /\b(\p{L}{1,4})-(?=\1)/giu;

// One word's tokens: its spelled-out form, a Thai run split into characters (with any Latin letters
// glued to it, "ok่ะ", split back out), or the word, unless it repeats the last one ("the the": a
// stutter, counted once).
function wordTokens(word: string, last: string | undefined): string[] {
  const spelled = SPELLED.get(word);
  if (spelled) {
    return spelled.split(" ");
  }
  if (THAI.test(word)) {
    return (word.match(THAI_OR_NOT) ?? []).flatMap((part) =>
      THAI.test(part) ? [...part] : [part]
    );
  }
  return word === last ? [] : [word];
}

export function tokens(text: string): string[] {
  const out: string[] = [];
  const cleaned = text
    .normalize("NFKC")
    .toLowerCase()
    .replace(FRAGMENT, "")
    // "l'homme" and "l homme" are the same words.
    .replace(JOINERS, " ")
    .replace(SYMBOLS, " ");
  for (const word of cleaned.split(SPACES)) {
    if (word && !FILLERS.has(word)) {
      out.push(...wordTokens(word, out.at(-1)));
    }
  }
  return out;
}

// One step of an alignment: a reference token matched or replaced (`ref` and `hyp`), dropped (`ref`
// only) or a hypothesis token inserted (`hyp` only).
interface Step {
  hyp?: string;
  ref?: string;
}

// Levenshtein costs of every prefix pair, row by row: cost[i * (b.length + 1) + j].
function costs(a: string[], b: string[]) {
  const w = b.length + 1;
  const cost = new Uint32Array((a.length + 1) * w);
  for (let i = 0; i <= a.length; i += 1) {
    for (let j = 0; j <= b.length; j += 1) {
      const at = i * w + j;
      cost[at] =
        i === 0 || j === 0
          ? i + j
          : Math.min(
              (cost[at - w] ?? 0) + 1,
              (cost[at - 1] ?? 0) + 1,
              (cost[at - w - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1)
            );
    }
  }
  return cost;
}

// The cheapest alignment of two token lists, in order: back from the end of the costs.
function align(a: string[], b: string[]): Step[] {
  const cost = costs(a, b);
  const w = b.length + 1;
  const steps: Step[] = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    const at = i * w + j;
    const ref = a[i - 1] ?? "";
    const hyp = b[j - 1] ?? "";
    const diagonal = (cost[at - w - 1] ?? 0) + (ref === hyp ? 0 : 1);
    if (i > 0 && j > 0 && cost[at] === diagonal) {
      steps.push({ hyp, ref });
      i -= 1;
      j -= 1;
    } else if (i > 0 && cost[at] === (cost[at - w] ?? 0) + 1) {
      steps.push({ ref });
      i -= 1;
    } else {
      steps.push({ hyp });
      j -= 1;
    }
  }
  return steps.reverse();
}

export const distance = (a: string[], b: string[]) =>
  align(a, b).filter((s) => s.ref !== s.hyp).length;

// Errors and reference length, so rates add up across clips by weight, not by clip.
export function errors(reference: string, hypothesis: string) {
  const ref = tokens(reference);
  return { errors: distance(ref, tokens(hypothesis)), length: ref.length };
}

// Small words: dropping or adding one rarely changes what was said. Some are both languages'
// ("on", "me"): the words of one language only tell French and English apart (sample.ts).
const SMALL_EN = (
  "a an and are as at be but by do for from has have he her his i if in is it its me my no not of " +
  "on or our so that the their them they this to us was we were what with you your"
).split(" ");
const SMALL_FR = (
  "à au aux avec ce ces c ça d dans de des du elle en est et eu il ils j je l la le les leur lui m " +
  "ma me mes mon n ne nous on ou par pas pour qu que qui s sa se ses si son sur t ta te tes toi ton " +
  "tu un une vous y"
).split(" ");
const SMALL = new Set([...SMALL_EN, ...SMALL_FR]);
export const ONLY_EN = SMALL_EN.filter((w) => !SMALL_FR.includes(w));
export const ONLY_FR = SMALL_FR.filter((w) => !SMALL_EN.includes(w));

// Two spellings of one word: at most a third of the letters differ ("realise", "réalisé").
const nearly = (a: string, b: string) =>
  distance([...a], [...b]) <=
  Math.max(1, Math.floor(Math.max(a.length, b.length) / 3));

// Drift: errors on what was said, not on how it was written. Only a word that is not small and
// was dropped, added or replaced by a really different word counts, over the reference's words
// that are not small. For Latin script only: a Thai character has no "small" or "nearly".
export function wordErrors(reference: string, hypothesis: string) {
  const ref = tokens(reference);
  let wrong = 0;
  for (const s of align(ref, tokens(hypothesis))) {
    const content = [s.ref, s.hyp].some(
      (w) => w !== undefined && !SMALL.has(w)
    );
    const same =
      s.ref !== undefined && s.hyp !== undefined && nearly(s.ref, s.hyp);
    if (s.ref !== s.hyp && content && !same) {
      wrong += 1;
    }
  }
  return { errors: wrong, length: ref.filter((w) => !SMALL.has(w)).length };
}

// A model's language, whatever it calls it ("French", "fr", "fra"), as Scribe's ISO 639-3 code;
// from one per chunk (Qwen3), the most frequent.
const LANGUAGES: Record<string, string> = {
  en: "eng",
  eng: "eng",
  english: "eng",
  fr: "fra",
  fra: "fra",
  french: "fra",
  th: "tha",
  tha: "tha",
  thai: "tha",
};
export function languageOf(said: string | string[] | null | undefined) {
  const all = (Array.isArray(said) ? said : [said]).flatMap((l) =>
    l ? [LANGUAGES[l.trim().toLowerCase()] ?? l] : []
  );
  const count = (l: string) => all.filter((x) => x === l).length;
  return all.sort((a, b) => count(b) - count(a))[0] ?? null;
}

export interface Turn {
  end: number;
  speaker: string;
  start: number;
}

// Words credited to the wrong speaker: each reference word goes to the turn holding its middle,
// and the labels are paired one to one, the most shared words first (labels are arbitrary). A
// word in no turn counts as wrong.
export function speakerErrors(
  words: { end: number; speakerId: string | null; start: number }[],
  turns: Turn[]
) {
  const scored = words.filter((w) => w.speakerId !== null);
  const pairs = new Map<string, number>();
  for (const w of scored) {
    const middle = (w.start + w.end) / 2;
    const turn = turns.find((t) => t.start <= middle && middle < t.end);
    if (turn) {
      const key = `${w.speakerId}\u0000${turn.speaker}`;
      pairs.set(key, (pairs.get(key) ?? 0) + 1);
    }
  }
  const usedRef = new Set<string>();
  const usedHyp = new Set<string>();
  let right = 0;
  for (const [key, n] of [...pairs].sort((a, b) => b[1] - a[1])) {
    const [ref = "", hyp = ""] = key.split("\u0000");
    if (!(usedRef.has(ref) || usedHyp.has(hyp))) {
      usedRef.add(ref);
      usedHyp.add(hyp);
      right += n;
    }
  }
  return { errors: scored.length - right, length: scored.length };
}

export interface Output {
  language?: string | string[] | null;
  segments?: Record<string, unknown>[] | null;
  text?: string;
  wallSeconds: number;
}

// Who spoke when, from a model that says: a diarizer's `speaker`, VibeVoice's `speaker_id`.
export function turnsOf(out: Output): Turn[] | null {
  const turns = (out.segments ?? []).flatMap((s) => {
    const speaker = s.speaker ?? s.speaker_id;
    return speaker === undefined ||
      typeof s.start !== "number" ||
      typeof s.end !== "number"
      ? []
      : [{ end: s.end, speaker: String(speaker), start: s.start }];
  });
  return turns.length > 0 ? turns : null;
}

export interface Clip extends Pick {
  // The window of the job's prepared audio this clip holds, in seconds.
  end: number;
  start: number;
  words: Word[];
}

const textOf = (words: Word[]) =>
  words
    .map((w) => w.spacing + w.text)
    .join("")
    .trim();

export const pct = (e: number, n: number) =>
  n > 0 ? `${((100 * e) / n).toFixed(1)}%` : "–";

const DRIFT: Group[] = ["en", "fr", "fr+en"];
const SPOKEN: Partial<Record<Group, string>> = {
  en: "eng",
  fr: "fra",
  th: "tha",
};

// One model's sums over the clips it ran on: text errors and drift by group, wrong languages,
// speakers.
export function tally(ran: { clip: Clip; out: Output }[]) {
  const sums = new Map<string, { e: number; n: number }>();
  for (const { clip, out } of ran) {
    for (const [key, s] of measures(clip, out)) {
      const a = sums.get(key) ?? { e: 0, n: 0 };
      sums.set(key, { e: a.e + s.errors, n: a.n + s.length });
    }
  }
  const audio = ran.reduce((t, r) => t + r.clip.end - r.clip.start, 0);
  const wall = ran.reduce((t, r) => t + r.out.wallSeconds, 0);
  return {
    has: (key: string) => sums.has(key),
    rate: (key: string) => {
      const { e, n } = sums.get(key) ?? { e: 0, n: 0 };
      return pct(e, n);
    },
    speed: wall > 0 ? `${(audio / wall).toFixed(0)}×` : "–",
  };
}

// What one clip adds to a model's sums, by key.
function measures(
  clip: Clip,
  out: Output
): [string, { errors: number; length: number }][] {
  const found: [string, { errors: number; length: number }][] = [];
  if (out.text !== undefined) {
    const reference = textOf(clip.words);
    found.push([`text ${clip.group}`, errors(reference, out.text)]);
    // Drift is for the 90%: English and French, alone or together.
    if (DRIFT.includes(clip.group)) {
      found.push([`drift ${clip.group}`, wordErrors(reference, out.text)]);
    }
  }
  // A clip of one language only: Scribe's language is the answer.
  const expected = SPOKEN[clip.group];
  const detected = languageOf(out.language);
  if (detected && expected) {
    found.push([
      "language",
      { errors: detected === expected ? 0 : 1, length: 1 },
    ]);
  }
  const turns = turnsOf(out);
  if (turns && clip.several) {
    found.push(["speakers", speakerErrors(clip.words, turns)]);
  }
  return found;
}
