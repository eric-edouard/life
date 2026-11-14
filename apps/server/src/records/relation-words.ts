// The words someone uses for a person by what they are to him ("my father", "mon père"): generic vocabulary in English
// and French, never his data. Each entry is one relation: the words that say it (the first is its name), its group
// (family, romantic, friend, work or other) and `one` when the word names one person by its nature ("my father"):
// only those place a person (`placementOf`, `memory/mention-placement.ts`). A word like "friend" or "brother" may be one of several the directory lists.

/** Written without accents: a text is compared as `keyOf` makes it. */
export const RELATION_WORDS: {
  group: string;
  one?: true;
  words: string[];
}[] = [
  { group: "family", one: true, words: ["father", "dad", "papa", "pere"] },
  {
    group: "family",
    one: true,
    words: ["mother", "mom", "mum", "mama", "maman", "mere"],
  },
  { group: "family", words: ["brother", "frere"] },
  { group: "family", words: ["sister", "soeur"] },
  { group: "family", words: ["son", "fils"] },
  { group: "family", words: ["daughter", "fille"] },
  { group: "family", words: ["grandfather", "grandpa", "grand pere"] },
  { group: "family", words: ["grandmother", "grandma", "grand mere"] },
  { group: "family", words: ["uncle", "oncle"] },
  { group: "family", words: ["aunt", "tante"] },
  { group: "family", words: ["cousin", "cousine"] },
  { group: "romantic", one: true, words: ["wife", "epouse", "femme"] },
  { group: "romantic", one: true, words: ["husband", "epoux", "mari"] },
  { group: "romantic", words: ["partner", "partenaire"] },
  {
    group: "romantic",
    one: true,
    words: ["girlfriend", "petite amie", "copine"],
  },
  { group: "romantic", one: true, words: ["boyfriend", "petit ami"] },
  { group: "romantic", one: true, words: ["fiance", "fiancee"] },
  { group: "friend", words: ["friend", "ami", "amie", "copain", "pote"] },
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

/** Does this relation's name (`relationWordOf`) name one person by its nature? */
export const namesOne = (word: string) => entryOf(word)?.one === true;

/** Does the text start with its speaker's own possessive ("ma mère", "my dad")? Only then is a relation word the speaker's own. */
export const saysMine = (text: string) => MINE.test(`${keyOf(text)} `);

/** Pronouns, English and French: the only words an earlier naming may stand for (`placementOf`). A closed list, never a name. */
export const PRONOUNS = new Set([
  "he",
  "him",
  "she",
  "her",
  "they",
  "them",
  "il",
  "elle",
  "lui",
  "ils",
  "elles",
  "eux",
]);

/** Is the text, whole, one of the pronouns? */
export const isPronoun = (text: string) => PRONOUNS.has(keyOf(text));
