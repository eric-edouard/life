import { SubjectRef } from "../records/fields";
import { isDay } from "./zones";

// A read part: one bounded piece of what Life holds about a subject, opened by its ref through `fetch` (and `person
// --part`), each ending with the exact refs of its deeper reads (`nextReads`). A ref is worked out, never stored.

/** The parts that exist; `now` is a subject's first page, `evidence` its observations, episodes and chats, paged back. */
export const READ_PARTS = ["now", "evidence"] as const;
export type ReadPart = (typeof READ_PARTS)[number];

/** About how many characters an `evidence` part holds; a day is never cut, so the last one may pass it. */
export const PART_CHARS = 6000;

/** `<subject ref>/<part>[/<span>][/before/<day>]`, as a value: `person:ana/evidence/2024-03/before/2024-03-15`. */
export interface ReadPartRef {
  before?: string;
  part: ReadPart;
  span?: string;
  subject: string;
}

/** What a ref starts with when it is a subject's: anything that does goes to a part read, never to `fetch`'s lookup. */
export const SUBJECT_PREFIX = /^(?:person|project|area):/;

const SPAN = /^\d{4}(?:-\d{2})?$/;

/** Why these are not a read part (a part that does not exist, a span or `before` that part cannot take), else null. */
export function partErrorOf(o: {
  before?: string;
  part: string;
  span?: string;
}) {
  if (!READ_PARTS.includes(o.part as ReadPart)) {
    return `no part "${o.part}" (parts: ${READ_PARTS.join(", ")})`;
  }
  if (o.part === "now" && (o.span || o.before)) {
    return 'the part "now" takes no span and no before';
  }
  if (o.span && !SPAN.test(o.span)) {
    return `span "${o.span}" is not a year (YYYY) or a month (YYYY-MM)`;
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
