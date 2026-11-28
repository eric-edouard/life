// An export whose structure Life does not know, said as its shape alone: a parser met one and stopped, and what a
// person reads (the caretaker's mail, `docs/sources.md`) is structure, never content. An export's files are untrusted
// and carry his life: file names become patterns, keys and column names are kept only when they are structure, and
// nothing else of it ever leaves (not a line's words, a name, a phone, an email).

/** What a shape report says: the format, its files as patterns, its keys and column names, and counts. */
export interface Shape {
  counts: Record<string, number>;
  files: string[];
  format: string;
  keys: string[];
}

/** The words of a file name that are structure, kept as they are: everything else is a name, a phone or an email. */
const STRUCTURAL = new Set([
  "activity",
  "archive",
  "audio",
  "chat",
  "chats",
  "claude",
  "conversation",
  "conversations",
  "csv",
  "data",
  "export",
  "exports",
  "files",
  "html",
  "instagram",
  "json",
  "mbox",
  "media",
  "message",
  "messages",
  "photos",
  "txt",
  "videos",
  "whatsapp",
  "with",
  "xml",
  "your",
  "zip",
]);

const WORD = /[A-Za-z0-9]+/g;
/** An extension, kept as it is: it names the file's kind, never someone. */
const EXTENSION = /\.[A-Za-z0-9]{1,6}$/;
/** A part glued to a structural word (`conversations-000`): structure too. */
const GLUED = /^[-_]*$/;
const DIGITS = /^\d+$/;
const SPACE = /\s/;

/**
 * A file name as a pattern: each run of words that is no structural word becomes one `*`, so
 * "WhatsApp Chat with Jane Doe.txt" is "WhatsApp Chat with *.txt" and "conversations-000.json" stays itself.
 */
export function patternOf(name: string) {
  const extension = EXTENSION.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - extension.length);
  let out = "";
  let replaced = false;
  let glued = false;
  let last = 0;
  for (const match of stem.matchAll(WORD)) {
    const [word] = match;
    const gap = stem.slice(last, match.index);
    last = match.index + word.length;
    const structural = STRUCTURAL.has(word.toLowerCase());
    // A part number glued to a structural word is structure; a phone never is (its digits stand apart).
    const part: boolean = glued && DIGITS.test(word);
    if (structural || part) {
      out += gap + word;
      replaced = false;
    } else if (!replaced) {
      // One `*` for a whole run, and none of his own separators: `+44 7700 900123` is `*`, a space stays a space.
      const spaced = SPACE.test(gap);
      out += out !== "" && spaced && !out.endsWith(" ") ? " *" : "*";
      replaced = true;
    }
    glued = (structural || part) && GLUED.test(gap);
  }
  if (!replaced) {
    out += stem.slice(last);
  }
  return out + extension;
}

/** A key or column name, kept only when it is structure: letters, digits and `_`, never a word of a line. */
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

/** A key or a column name as a report says it, or none. */
export const keyOf = (name: string) => (KEY.test(name) ? name : undefined);

const most = 40;
/** The keys of a parsed export, at a ceiling: structure only (`keyOf`), never a value. */
export function keysOf(json: unknown) {
  const keys = new Set<string>();
  const walk = (value: unknown, depth: number) => {
    if (depth > 6 || keys.size >= most) {
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 5)) {
        walk(item, depth + 1);
      }
    } else if (value && typeof value === "object") {
      for (const [key, inside] of Object.entries(value)) {
        if (keyOf(key)) {
          keys.add(key);
        }
        walk(inside, depth + 1);
      }
    }
  };
  walk(json, 0);
  return [...keys].slice(0, most).sort();
}

const SAID = "Life does not know this export's structure";

/**
 * A parser met an export it cannot read, as an error: its `message` is one fixed sentence and the JSON of the shape,
 * and its fields are the shape itself (a log line's, the caretaker's mail).
 */
export class ShapeReport extends Error {
  readonly counts: Record<string, number>;
  readonly files: string[];
  readonly format: string;
  readonly keys: string[];

  // No `cause`: a parser's own error can quote the file's words.
  constructor(shape: Shape) {
    // Only the checked shape is kept, and only it is said: a name or a line's words never reach the message.
    const fields: Shape = {
      counts: shape.counts,
      files: shape.files.map(patternOf),
      format: shape.format,
      keys: shape.keys.flatMap((key) => {
        const kept = keyOf(key);
        return kept ? [kept] : [];
      }),
    };
    super(`${SAID}: ${JSON.stringify(fields)}`);
    this.name = "ShapeReport";
    this.counts = fields.counts;
    this.files = fields.files;
    this.format = fields.format;
    this.keys = fields.keys;
  }

  /** The shape alone, as a log line's fields. */
  get fields(): Shape {
    return {
      counts: this.counts,
      files: this.files,
      format: this.format,
      keys: this.keys,
    };
  }
}

/** A shape report for `format`: its files are patterned and its keys checked, so no name or word of it can pass. */
export const shapeOf = (
  format: string,
  parts: Partial<Omit<Shape, "format">> = {}
) =>
  new ShapeReport({
    counts: parts.counts ?? {},
    files: parts.files ?? [],
    format,
    keys: parts.keys ?? [],
  });
