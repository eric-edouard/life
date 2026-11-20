// The words of a person check's ask: its question, and its context, why Life asks (a Contacts card's too). Context is
// Markdown: recorded words go in through `literalOf`.

const SPACES = /\s+/g;
/** Markdown's marks, an autolink's `://` and `www.`. */
const MARKS = /[\\`*_[\]<>#~&@]|:(?=\/\/)|(?<=\bwww)\./gi;
const LIST_NUMBER = /^(\d+)([.)])/;
const LIST_MARK = /^[-+=]/;

/** Recorded words as Markdown that renders as written, on one line: no link, emphasis, HTML, code or list of their own. */
export const literalOf = (s: string) =>
  s
    .replace(SPACES, " ")
    .trim()
    .replace(MARKS, "\\$&")
    .replace(LIST_NUMBER, "$1\\$2")
    .replace(LIST_MARK, "\\$&");

/** The question of a person check: "Is this Kit Moreau?", the whole name; a description ("the plumber fixing the sink") is kept whole too. */
export const personQuestionOf = (name: string) => `Is this ${name.trim()}?`;

/** A guessed person's identity ask: "Is this Kit Moreau?", and its context, why Life thinks so in one sentence. */
export const guessAskOf = (p: {
  confidence: number;
  name: string;
  relation: string;
}) => ({
  context: `Life read their messages as ${literalOf(p.name)}, ${literalOf(p.relation)} (${Math.round(p.confidence * 100)}% sure).`,
  question: personQuestionOf(p.name),
});

/** A Contacts card's ask: "Whose contact is this?", its context (which card) and the card's own name and handles; the people it may be are the options. */
export const cardAskOf = (name: string, handles: string[]) => ({
  contactsCard: { handles, name },
  context: `It is the Contacts card ${literalOf(name)}.`,
  question: "Whose contact is this?",
});
