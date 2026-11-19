import { firstNameOf } from "../records/truth";

// The words of a person check's ask: its question, and its context, why Life asks.

/** A name that starts with a capital letter; a description ("the plumber fixing the sink") does not. */
const CAPITAL = /^\p{Lu}/u;

/**
 * The question of a person check: "Is this Kit?", or of a card two people fit, "Is this Gran or Robin?". A name is
 * called by its first name; a description is kept whole, and so are names whose first names collide ("Robin Vale or
 * Robin Hart").
 */
export const personQuestionOf = (names: string[]) => {
  const whole = names.map((n) => n.trim());
  const called = whole.map((n) => (CAPITAL.test(n) ? firstNameOf(n) : n));
  return `Is this ${(new Set(called).size < called.length ? whole : called).join(" or ")}?`;
};

/** A guessed person's identity ask: "Is this Kit?", and its context, why Life thinks so in one sentence. */
export const guessAskOf = (p: {
  confidence: number;
  name: string;
  relation: string;
}) => ({
  context: `Life read their messages as ${p.name}, ${p.relation} (${Math.round(p.confidence * 100)}% sure).`,
  question: personQuestionOf([p.name]),
});

/** A Contacts card's identity ask: "Is this Gran or Robin?", and its context: which card. */
export const cardAskOf = (card: string, people: { name: string }[]) => ({
  context: `It is the Contacts card ${card}.`,
  question: personQuestionOf(people.map((p) => p.name)),
});
