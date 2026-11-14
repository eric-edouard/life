// The words someone uses for a person by what they are to him ("my father", "mon père"): generic vocabulary in English
// and French, never his data. Each entry is one relation: the words that say it (the first is its name) and its group.

export type RelationGroup = "family" | "friend" | "other" | "romantic" | "work";

/** Written without accents: a text is compared as `keyOf` makes it. */
export const RELATION_WORDS: { group: RelationGroup; words: string[] }[] = [
  { group: "family", words: ["father", "dad", "papa", "pere"] },
  { group: "family", words: ["mother", "mom", "mum", "mama", "maman", "mere"] },
  { group: "family", words: ["brother", "frere"] },
  { group: "family", words: ["sister", "soeur"] },
  { group: "family", words: ["son", "fils"] },
  { group: "family", words: ["daughter", "fille"] },
  { group: "family", words: ["grandfather", "grandpa", "grand pere"] },
  { group: "family", words: ["grandmother", "grandma", "grand mere"] },
  { group: "family", words: ["uncle", "oncle"] },
  { group: "family", words: ["aunt", "tante"] },
  { group: "family", words: ["cousin", "cousine"] },
  { group: "romantic", words: ["wife", "epouse", "femme"] },
  { group: "romantic", words: ["husband", "epoux", "mari"] },
  { group: "romantic", words: ["partner", "partenaire"] },
  {
    group: "romantic",
    words: ["girlfriend", "petite amie", "boyfriend", "petit ami"],
  },
  { group: "friend", words: ["friend", "ami", "amie", "copain", "copine"] },
  { group: "work", words: ["boss", "patron", "patronne"] },
  { group: "work", words: ["colleague", "coworker", "collegue"] },
  { group: "other", words: ["neighbor", "neighbour", "voisin", "voisine"] },
];

const keyOf = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
/** His own possessive before it: "my father", "mon père". */
const MINE = /^(?:my|mon|ma|mes) /;

const entryOf = (text: string) => {
  const key = keyOf(text).replace(MINE, "");
  return RELATION_WORDS.find((e) => e.words.includes(key));
};

/** The name of the relation `text` says whole ("my dad" and "père" are "father" and "father"), else undefined: "Paul's sister" or "father of Lena" say none. */
export const relationWordOf = (text: string) => entryOf(text)?.words[0];

/** The group of a relation by its name (`relationWordOf`). */
export const relationGroupOf = (word: string) => entryOf(word)?.group;
