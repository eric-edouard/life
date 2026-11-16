import { SubjectRef } from "../records/fields";
import { parseTurnRef } from "../sources/lifelog";
import { isDay } from "./zones";

// A read part: one bounded piece of what Life holds about a subject, opened by its ref through `fetch` (and `person
// --part`), each ending with the exact refs of its deeper reads (`nextReads`). A ref is worked out, never stored.

/**
 * The grammar of a part's ref: every part a ref can name. Which ones a read offers is its own (`person`: the parts an
 * add-on supplies only while it is on). The parts: `now` (who and where things stand), `page`, `persona`, `story` (the years), `year` (its months'
 * summaries, paged back), `month` (its words and days), `evidence` (observations, episodes and chats, paged back) and
 * `conversation` (his alone: one conversation summary, its span the ref of the turn it starts at).
 */
export const READ_PARTS = [
  "now",
  "page",
  "persona",
  "story",
  "year",
  "month",
  "evidence",
  "conversation",
] as const;
/** The parts an add-on supplies (`personal/`): offered only while it is on. */
export const ADD_ON_PARTS: readonly string[] = [
  "persona",
  "story",
  "year",
  "month",
];
export type ReadPart = (typeof READ_PARTS)[number];

/** About how many characters a part holds; a day is never cut, so the last one may pass it. */
export const PART_CHARS = 6000;

/** `<subject ref>/<part>[/<span>][/before/<day>]`, as a value: `person:ana/evidence/2024-03/before/2024-03-15`. */
export interface ReadPartRef {
  before?: string;
  part: ReadPart;
  span?: string;
  subject: string;
}

const SPAN = /^\d{4}(?:-\d{2})?$/;

/** Why `span` is not one this part takes the form of: a turn's ref for `conversation`, else a year or a month. */
function spanErrorOf(part: string, span?: string) {
  if (part === "conversation") {
    return span && parseTurnRef(span)
      ? null
      : 'the part "conversation" takes the ref of a recording\'s turn as its span (<job>:<turn>@<instant>)';
  }
  return span && !SPAN.test(span)
    ? `span "${span}" is not a year (YYYY) or a month (YYYY-MM)`
    : null;
}

/** Why these are not a read part (a part that does not exist, a span or `before` that part cannot take), else null. */
export function partErrorOf(
  o: {
    before?: string;
    part: string;
    span?: string;
  },
  offered: readonly string[] = READ_PARTS
) {
  if (!offered.includes(o.part)) {
    return `no part "${o.part}" (parts: ${offered.join(", ")})`;
  }
  const bad = spanErrorOf(o.part, o.span);
  if (bad) {
    return bad;
  }
  if (o.part === "year" || o.part === "month") {
    const size = o.part === "year" ? 4 : 7;
    if (o.span?.length !== size) {
      return `the part "${o.part}" takes a ${o.part} as its span (${size === 4 ? "YYYY" : "YYYY-MM"})`;
    }
  } else if (o.part !== "evidence" && o.part !== "conversation" && o.span) {
    return `the part "${o.part}" takes no span`;
  }
  if (o.before && o.part !== "evidence" && o.part !== "year") {
    return `the part "${o.part}" takes no before`;
  }
  if (o.before && !isDay(o.before)) {
    return `before "${o.before}" is not a day (YYYY-MM-DD)`;
  }
  return null;
}

/** A ref's value, or the reason it is malformed. Only a person's parts exist so far; `openById` says so for others. */
export function parseReadPartRef(
  id: string
): { ref: ReadPartRef } | { error: string } {
  const [subject = "", part = "", ...rest] = id.split("/");
  const before =
    rest.length >= 2 && rest.at(-2) === "before" ? rest.at(-1) : undefined;
  const middle = before ? rest.slice(0, -2) : rest;
  const bad = (reason: string) => ({
    error: `"${id}" is not a read part ref (<subject>/<part>[/<span>][/before/<day>], like person:ana/evidence/2024-03): ${reason}`,
  });
  if (!SubjectRef.safeParse(subject).success) {
    return bad(`"${subject}" is not a subject ref`);
  }
  if (middle.length > 1) {
    return bad("too many segments");
  }
  const [span] = middle;
  const why = partErrorOf({ before, part, span });
  return why
    ? bad(why)
    : { ref: { before, part: part as ReadPart, span, subject } };
}

/** A ref as the text `fetch` takes. */
export const readPartRefOf = (r: ReadPartRef) =>
  [r.subject, r.part, r.span, ...(r.before ? ["before", r.before] : [])]
    .filter(Boolean)
    .join("/");

/** The lines that end a part: each deeper read as its ref and what it holds. */
export const nextReads = (reads: { ref: ReadPartRef; what: string }[]) => [
  "Next reads (`fetch <ref>`):",
  ...reads.map((r) => `- ${readPartRefOf(r.ref)}: ${r.what}`),
];
