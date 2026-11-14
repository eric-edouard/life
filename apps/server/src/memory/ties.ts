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

/** What follows a relation's words ("my partner Lea"), and what comes before them set apart ("Lea, my partner"). */
const AFTER = /^[\s,]+(.*)/s;
const BEFORE = /(.*?)\s*[,(–—-]\s*$/s;
const WORDS = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;

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

/**
 * The name a quote gives beside `words` that `resolve` knows: the one right after ("my partner Lea") or, set apart by a
 * comma, bracket or dash, right before ("Lea, my partner"); one to three words, the longest first.
 */
function nameBeside(
  quote: string,
  words: string,
  resolve: Pick<People, "resolve">["resolve"]
) {
  const at = quote.toLowerCase().indexOf(words.toLowerCase());
  if (at < 0) {
    return;
  }
  const after = quote.slice(at + words.length).match(AFTER)?.[1] ?? "";
  const before = quote.slice(0, at).match(BEFORE)?.[1] ?? "";
  const next = after.match(WORDS) ?? [];
  const last = before.match(WORDS) ?? [];
  return [3, 2, 1]
    .flatMap((n) => [next.slice(0, n).join(" "), last.slice(-n).join(" ")])
    .find((name) => name && resolve(name));
}

/**
 * The ties the mentions say: a mention whose `who` is a relation's words ("my partner") and whose quote has, right
 * beside them, a name that places by proof `name` ("my partner Lea"). Each is a line as it would be stored, never the
 * person said to be someone's own.
 */
export function tieLinesOf(
  mentions: Mention[],
  { resolve }: Pick<People, "resolve">
): Tie[] {
  const lines = new Map<string, Tie>();
  for (const m of mentions) {
    const name = relationWordOf(m.who)
      ? nameBeside(m.quote, m.who, resolve)
      : undefined;
    const by = m.by === OWNER ? OWNER : resolve(m.by);
    if (name && resolve(name) !== by) {
      const id = `tie_${digest("sha1", [m.unit, m.quote, m.who].join("|"), 12)}`;
      lines.set(id, {
        at: m.at,
        by: m.by,
        id,
        of: name,
        quote: m.quote,
        said: m.line,
        schemaVersion: 1,
        unit: m.unit,
        words: m.who,
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
 * over a stored one for the same pair (it keeps the quote). His directory: each person whose `relation`'s first clause is a
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
  const keep = (t: TieNow) =>
    now.set(`${t.by}|${t.of}`, { ...now.get(`${t.by}|${t.of}`), ...t });
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
