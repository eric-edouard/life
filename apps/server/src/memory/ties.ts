import { relationWordOf } from "../records/relation-words";
import { OWNER } from "./read-truth";

// What two people are to each other, as words. For now only his own: the relation his directory gives each person
// (`truth/people.yaml`, free text). Worked out when read, never stored.

/** `by` says `of` is its `word` (a relation's name, `relationWordOf`). Refs are today's. */
export interface Tie {
  by: string;
  of: string;
  word: string;
}

const CLAUSE_END = /[,;:./()\n]| [-–—] /;
/** The first clause of a free text: up to the first comma, semicolon, colon, stop, bracket, slash or dash set apart. */
const firstClause = (text: string) => text.split(CLAUSE_END)[0] ?? "";

/** His ties: each person whose relation's first clause is a listed word, whole ("father, lives in Lyon" is; "father of Lena" is not). */
export function tiesNow({
  canon,
  truth,
}: {
  canon: (ref: string) => string;
  truth: { people: { id: string; relation?: string }[] };
}): Tie[] {
  return truth.people.flatMap((p) => {
    const word = p.relation && relationWordOf(firstClause(p.relation));
    const of = canon(`person:${p.id}`);
    return word && of !== OWNER ? [{ by: OWNER, of, word }] : [];
  });
}
