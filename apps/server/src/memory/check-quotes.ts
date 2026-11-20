// A check's context is Markdown: recorded words go in literal (`literalOf`), and the words a guess of Life's rests on are
// quoted after its own (`withQuoteOf`), once, by `checksOf`.

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

/** The words a guess of Life's rests on, where they were said ("whatsapp, 7 Sep"), and the unit they were said in, if known. */
export interface Quote {
  text: string;
  unit?: string;
  where?: string;
}

/** A check's context with the words it rests on after its own: `> quote`, then `*where*`, a `life:` link to its unit when that unit was read (`isUnitRead`). */
export function withQuoteOf(
  context: string | null,
  isUnitRead: (id: string) => boolean,
  q?: Quote
) {
  if (!q) {
    return context;
  }
  const where = literalOf(q.where ?? "an earlier message");
  const source =
    q.unit && isUnitRead(q.unit) ? `[${where}](life:${q.unit})` : where;
  return `${context ? `${context}\n\n` : ""}> ${literalOf(q.text)}\n\n*${source}*`;
}
