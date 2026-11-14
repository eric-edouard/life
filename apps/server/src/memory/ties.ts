import { appendJsonl, readAppended } from "../core/files";
import { digest } from "../core/hash";
import { log } from "../core/log";
import { settings } from "../core/settings";
import type { Correction } from "../records/observation";
import { relationWordOf } from "../records/relation-words";
import { Tie, type TieNow } from "../records/tie";
import { TIES } from "./memory-files";
import { type Mention, readMentions } from "./mentions";
import { OWNER } from "./read-truth";
import type { People } from "./who";

// What two people are to each other, as words. His directory gives his own (`truth/people.yaml`, the relation free text);
// while his `ties` setting is on, the night also keeps what anyone said in the mentions ("my partner Lea", `memory/ties.jsonl`,
// `writeTies`: appended only, one line per quote, as written, no refs). The present ties are worked out when read.

const CLAUSE_END = /[,;:./()\n]| [-–—] /;
/** The first clause of a free text: up to the first comma, semicolon, colon, stop, bracket, slash or dash set apart. */
const firstClause = (text: string) => text.split(CLAUSE_END)[0] ?? "";

/** One to three words that may be a name, written with capitals ("Lea", "Jean Luc"): the capitals are checked where it is matched (`CAPITAL`). */
const NAME = String.raw`[\p{L}'’-]+(?:\s+[\p{L}'’-]+){0,2}`;
const CAPITAL = /^\p{Lu}/u;
const NAME_WORD = /\S+/g;
const ONE = String.raw`(?<![\p{L}\p{N}])`;

/** The ties the stored file holds, every line, in the order appended. */
export const readTies = () =>
  readAppended(
    TIES,
    Tie,
    (last?: Tie[]) => [...(last ?? [])],
    (all, t) => {
      all.push(t);
    }
  );

/** The ties he said are wrong (`not-this-tie`). */
const removedOf = (corrections: Correction[]) =>
  new Set(
    corrections.flatMap((c) => (c.kind === "not-this-tie" ? c.ties : []))
  );

/** The name right after `words` ("my partner Lea") that `resolve` knows, longest first, and the quote that says it. */
function nameAfter(
  line: string,
  words: string,
  resolve: Pick<People, "resolve">["resolve"]
) {
  for (const m of line.matchAll(
    new RegExp(`${ONE}${RegExp.escape(words)}\\s+(${NAME})`, "giu")
  )) {
    const run = m[1] ?? "";
    for (const w of [...run.matchAll(NAME_WORD)].toReversed()) {
      const name = run.slice(0, w.index + w[0].length);
      if (
        [...name.matchAll(NAME_WORD)].every((x) => CAPITAL.test(x[0])) &&
        resolve(name) &&
        !relationWordOf(name)
      ) {
        return {
          name,
          quote: m[0].slice(0, m[0].length - run.length + name.length),
          words,
        };
      }
    }
  }
}

/** The speaker's own relation words right before `name` ("my partner" before "Lea"), and the quote that says it. */
function wordsBefore(line: string, name: string) {
  for (const m of line.matchAll(
    new RegExp(
      `${ONE}((?:my|mon|ma|mes)\\s+\\p{L}+(?:\\s+\\p{L}+)?)\\s+${RegExp.escape(name)}(?![\\p{L}\\p{N}])`,
      "giu"
    )
  )) {
    if (relationWordOf(m[1] ?? "") && m[0].endsWith(name)) {
      return { name, quote: m[0], words: m[1] ?? "" };
    }
  }
}

/** The words and the name a mention's line puts together, from the mention's `who`: the words, else a name. */
function tieIn(m: Mention, resolve: Pick<People, "resolve">["resolve"]) {
  if (relationWordOf(m.who)) {
    return nameAfter(m.line, m.who, resolve);
  }
  return resolve(m.who) && CAPITAL.test(m.who)
    ? wordsBefore(m.line, m.who)
    : undefined;
}

/**
 * The ties the mentions say: the speaker's own relation words right beside a name that places by proof `name` ("my
 * partner Lea", the tie's quote) in the message line of a mention, whether the mention gives the name as `who` or the
 * words. Each is a line as it would be stored, never one that says someone is their own.
 */
export function tieLinesOf(
  mentions: Mention[],
  { resolve }: Pick<People, "resolve">
): Tie[] {
  const lines = new Map<string, Tie>();
  for (const m of mentions) {
    const found = tieIn(m, resolve);
    const by = m.by === OWNER ? OWNER : resolve(m.by);
    if (found && resolve(found.name) !== by) {
      const { name, quote, words } = found;
      const id = `tie_${digest("sha1", [m.unit, quote, words].join("|"), 12)}`;
      lines.set(id, {
        at: m.at,
        by: m.by,
        id,
        of: name,
        quote,
        said: m.line,
        schemaVersion: 1,
        unit: m.unit,
        words,
      });
    }
  }
  return [...lines.values()];
}

/**
 * Keeps the ties the kept mentions say (the night's step, while his `ties` setting is on; it runs inside the night's lock, which
 * everything that writes `memory/` holds). It only appends, and never a line already stored or one he called wrong
 * (`not-this-tie`). A failure is logged and the night goes on.
 */
export function writeTies(people: Pick<People, "corrections" | "resolve">) {
  try {
    const skip = new Set([
      ...readTies().map((t) => t.id),
      ...removedOf(people.corrections),
    ]);
    const mentions = Object.values(readMentions() ?? {})
      .flat()
      .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at));
    const lines = tieLinesOf(mentions, people).filter((t) => !skip.has(t.id));
    appendJsonl(TIES, Tie, lines);
    return { failed: 0, ties: lines.length };
  } catch (e) {
    log("run.error", { error: (e as Error).message, step: "memory.ties" });
    return { failed: 1, ties: 0 };
  }
}

/**
 * The ties as they stand, one per pair of people as one says the other is: the stored lines (less those he called
 * wrong) by who and of whom they resolve to today, the newest line of a pair the present one, and his directory's word
 * over a stored one for the same pair. His directory: each person whose `relation`'s first clause is a
 * listed word, whole ("father, lives in Lyon" is; "father of Lena" is not).
 */
export function tiesNow(
  {
    canon,
    corrections = [],
    resolve,
    truth,
  }: Pick<People, "canon" | "resolve"> & {
    corrections?: Correction[];
    truth: { people: { id: string; relation?: string }[] };
  },
  stored: Tie[] = settings().ties ? readTies() : []
): TieNow[] {
  const removed = removedOf(corrections);
  const now = new Map<string, TieNow>();
  const keep = (t: TieNow) => now.set(`${t.by}|${t.of}`, t);
  for (const t of stored
    .filter((s) => !removed.has(s.id))
    .toSorted((a, b) => Date.parse(a.at) - Date.parse(b.at))) {
    const by = t.by === OWNER ? OWNER : resolve(t.by);
    const of = resolve(t.of);
    const word = relationWordOf(t.words);
    if (by && of && word && by !== of) {
      keep({ by, of, quote: t.quote, word });
    }
  }
  for (const p of truth.people) {
    const word = p.relation && relationWordOf(firstClause(p.relation));
    const of = canon(`person:${p.id}`);
    if (word && of !== OWNER) {
      keep({ by: OWNER, of, word });
    }
  }
  return [...now.values()];
}
