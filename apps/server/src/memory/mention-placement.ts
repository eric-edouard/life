import {
  isPronoun,
  namesOne,
  relationWordOf,
  saysMine,
} from "../records/relation-words";
import type { SourceEvent } from "../records/source";
import { OWNER } from "./read-truth";
import type { Tie } from "./ties";
import { nameKey, textOf } from "./units";
import { namedIn, type People } from "./who";

// Who a mention means, decided in this one place. Code's own reading of the words (a name, his relation word) is the
// floor: it stands whatever a model picked. A read's pick (`ref`) only adds the earlier naming, and only for a pronoun.

/** A line as the placement reads it: who said it (`OWNER` when he sent it, else the sender as the source names it) and its text. */
export interface Said {
  by: string;
  line: string;
}
export const saidOf = (e: SourceEvent): Said => ({
  by: e.fromMe ? OWNER : e.sender,
  line: textOf(e),
});

type Placing = Pick<People, "resolve">;

/** Are the words of `who` on the line `line`, whole? */
const isOnLine = (who: string, line: string) => {
  const words = ` ${nameKey(who)} `;
  return words.trim() !== "" && ` ${nameKey(line)} `.includes(words);
};

/**
 * What code reads in a mention's words alone: `name`, the person its whole `who` resolves to (`people.resolve`, so a
 * fold or a name given since moves it); else `relation_word`, when its `who` is a relation's word ("my father") and
 * exactly one of its speaker's `ties` is that relation and the word names one person by its nature (`one`,
 * `records/relation-words.ts`; "my brother" or "my friend" never) (two fathers, or none, mean no one). Either way its
 * words must be on its line; else no one. "Paul's sister" is not "Paul": a part of a name never counts.
 */
function byWordsOf(
  mention: { by: string; line: string; who: string },
  people: Placing,
  ties: Tie[]
) {
  if (!isOnLine(mention.who, mention.line)) {
    return null;
  }
  const ref = people.resolve(mention.who);
  if (ref) {
    return { proof: "name" as const, ref };
  }
  const word = relationWordOf(mention.who);
  const speaker = mention.by === OWNER ? OWNER : people.resolve(mention.by);
  if (!(word && namesOne(word))) {
    return null;
  }
  const of = new Set(
    ties.filter((t) => t.by === speaker && t.word === word).map((t) => t.of)
  );
  const [only] = of;
  return of.size === 1 && only
    ? { proof: "relation_word" as const, ref: only }
    : null;
}

/**
 * The people a line names: a name, alias or handle `people.resolve` knows, or the speaker's own relation word with its
 * possessive ("ma mère") when exactly one tie holds (`byWordsOf`). The reads' own: extraction and the episodes keep
 * `namedIn` over `resolve` alone, because who is shown to extraction is a model input, changed only with its own measure.
 */
export function peopleNamedBy(
  said: Said,
  people: Pick<People, "canon" | "resolve">,
  ties: Tie[]
) {
  const found = namedIn(
    [said.line],
    (s) =>
      people.resolve(s) ??
      (saysMine(s)
        ? (byWordsOf({ ...said, who: s }, people, ties)?.ref ?? null)
        : null),
    []
  );
  return new Set([...found].map((r) => people.canon(r)));
}

/**
 * Who a mention means, with the proof: code's own reading of its words (`byWordsOf`), whatever the read picked; else,
 * for a `who` that is a pronoun ("elle", "him") whose read picked someone (`ref`), `earlier_naming`: the line the
 * read pointed to (`namedOn`) names that person (`peopleNamedBy`). A pick never overrides code, never places an
 * unknown name or a relation word of several candidates, and `unknown` or an invented ref proves nothing.
 */
export function placementOf(
  mention: {
    by: string;
    line: string;
    namedOn?: Said;
    ref?: string;
    who: string;
  },
  people: Pick<People, "canon" | "resolve">,
  ties: Tie[]
) {
  const own = byWordsOf(mention, people, ties);
  if (own) {
    return own;
  }
  const { namedOn, ref } = mention;
  if (!(ref && namedOn && isPronoun(mention.who))) {
    return null;
  }
  const picked = people.canon(ref);
  return isOnLine(mention.who, mention.line) &&
    peopleNamedBy(namedOn, people, ties).has(picked)
    ? { proof: "earlier_naming" as const, ref: picked }
    : null;
}
