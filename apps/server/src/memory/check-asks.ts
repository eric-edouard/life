import { firstNameOf } from "../records/truth";

// The words of a person check's ask: its question, and its context, why Life asks (a Contacts card's too).

/** A name that starts with a capital letter; a description ("the plumber fixing the sink") does not. */
const CAPITAL = /^\p{Lu}/u;

/** The question of a person check: "Is this Kit?". A name is called by its first name; a description ("the plumber fixing the sink") is kept whole. */
export const personQuestionOf = (name: string) => {
  const whole = name.trim();
  return `Is this ${CAPITAL.test(whole) ? firstNameOf(whole) : whole}?`;
};

/** A guessed person's identity ask: "Is this Kit?", and its context, why Life thinks so in one sentence. */
export const guessAskOf = (p: {
  confidence: number;
  name: string;
  relation: string;
}) => ({
  context: `Life read their messages as ${p.name}, ${p.relation} (${Math.round(p.confidence * 100)}% sure).`,
  question: personQuestionOf(p.name),
});

/** A Contacts card's ask: "Whose contact is this?", its context (which card) and the card's own name and handles; the people it may be are the options. */
export const cardAskOf = (name: string, handles: string[]) => ({
  contactsCard: { handles, name },
  context: `It is the Contacts card ${name}.`,
  question: "Whose contact is this?",
});
