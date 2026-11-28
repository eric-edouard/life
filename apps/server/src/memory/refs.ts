import { SourceName } from "../core/names";
import { AppointmentId } from "../records/appointment";
import { EpisodeId, SUBJECT_PREFIX, UnitId } from "../records/fields";
import { LedgerEntry } from "../records/ledger-entry";
import { MatterId } from "../records/matter";
import { ObservationId } from "../records/observation";
import { parseTurnRef } from "../sources/voice-server";
import { isAskPage } from "./card-request";
import { DecisionId } from "./decision-lines";
import { parseReadPartRef, type ReadPartRef } from "./read-part";
import { isDay } from "./zones";

// The one grammar of what `fetch` opens (`openById`), which a card's `life:` links name and the phone is told the kind of
// (`lifeLinksOf`). Pure: whether a ref names something that exists is its kind's reader's to say (`find-refs.ts`).

/** A ref `fetch` takes, by kind; any other id is a conversation's (a recorded conversation or an imported one). */
export type Ref = { id: string } & (
  | { kind: "appointment" }
  | { kind: "ask" }
  | { kind: "card" }
  | { kind: "conversation" }
  | { kind: "episode" }
  | { kind: "file"; file: string }
  | { kind: "matter"; thread?: { before?: string; matter: string } }
  | { kind: "message"; message: string; source: SourceName }
  | { kind: "observation" }
  | { kind: "person"; read: ReadPartRef }
  | { jobId: string; kind: "turn"; turnIndex: number }
  | { kind: "unit" }
);
export type RefKind = Ref["kind"];

const LIFE = "life:";
/** A matter's thread: `<matter or step id>/thread[/before/<day>]` (`readMatterThread`). */
const THREAD = /^([^/]+)\/thread(?:\/before\/([^/]+))?$/;
const MESSAGE = "msg:";
const FILE = "file:";

/** The kinds told by their id's form alone. */
const BY_FORM: {
  is: (id: string) => boolean;
  kind: "appointment" | "card" | "episode" | "matter" | "observation" | "unit";
}[] = [
  { is: (id) => AppointmentId.safeParse(id).success, kind: "appointment" },
  { is: (id) => DecisionId.safeParse(id).success, kind: "card" },
  { is: (id) => EpisodeId.safeParse(id).success, kind: "episode" },
  {
    is: (id) =>
      MatterId.safeParse(id).success ||
      // A lone to-do item's matter has its key.
      LedgerEntry.shape.id.safeParse(id).success,
    kind: "matter",
  },
  { is: (id) => ObservationId.safeParse(id).success, kind: "observation" },
  { is: (id) => UnitId.safeParse(id).success, kind: "unit" },
];

/** A ref's kind and parts, or why it is malformed. */
export function parseRef(id: string): Ref | { error: string } {
  if (isAskPage(id)) {
    return { id, kind: "ask" };
  }
  if (SUBJECT_PREFIX.test(id)) {
    const read = parseReadPartRef(id);
    return "error" in read ? read : { id, kind: "person", read: read.ref };
  }
  if (id.startsWith(MESSAGE)) {
    return parseMessageRef(id);
  }
  const thread = THREAD.exec(id);
  if (thread) {
    return parseThreadRef(id, thread[1] as string, thread[2]);
  }
  if (id.startsWith(FILE)) {
    return id.length > FILE.length
      ? { file: id.slice(FILE.length), id, kind: "file" }
      : { error: `"${id}" is not a file ref (file:<ref>)` };
  }
  const form = BY_FORM.find((f) => f.is(id));
  if (form) {
    return { id, kind: form.kind };
  }
  const turn = parseTurnRef(id);
  if (turn) {
    return { id, kind: "turn", ...turn };
  }
  return id.trim() === id && id !== ""
    ? { id, kind: "conversation" }
    : { error: `"${id}" is not a ref` };
}

/** A matter's thread ref: its head a matter's id or a step's (a lone matter has its observation's or to-do item's), `before` a day. */
function parseThreadRef(
  id: string,
  matter: string,
  before: string | undefined
): Ref | { error: string } {
  const head = BY_FORM.find((f) => f.is(matter))?.kind;
  if (head !== "matter" && head !== "observation") {
    return { error: `"${matter}" in "${id}" is not a matter's id` };
  }
  if (before !== undefined && !isDay(before)) {
    return { error: `before "${before}" in "${id}" is not a day (YYYY-MM-DD)` };
  }
  return { id, kind: "matter", thread: { before, matter } };
}

/** A message ref: `msg:<source>|<id>` (`eventKey`), split at the first `|`, so the message id may hold anything. */
function parseMessageRef(id: string): Ref | { error: string } {
  const at = id.indexOf("|");
  const source = SourceName.safeParse(id.slice(MESSAGE.length, at));
  return at > 0 && source.success && at < id.length - 1
    ? { id, kind: "message", message: id.slice(at + 1), source: source.data }
    : { error: `"${id}" is not a message ref (msg:<source>|<message id>)` };
}

/** The `life:` destinations of a Markdown text's links and images (the phone opens both), as a Markdown reader finds them (never in code), percent-decoded, each once. */
export function lifeRefsOf(markdown: string) {
  const refs = new Set<string>();
  const add = (href: string) => {
    if (href.startsWith(LIFE)) {
      try {
        refs.add(decodeURIComponent(href.slice(LIFE.length)));
      } catch {
        refs.add(href.slice(LIFE.length));
      }
    }
    return "";
  };
  Bun.markdown.render(markdown, {
    image: (_: unknown, { src }: { src: string }) => add(src),
    link: (_: unknown, { href }: { href: string }) => add(href),
  });
  return [...refs];
}

/**
 * A card's `life:` links with their kinds, for the phone; worked out when read, never stored. A malformed one is left
 * out; a matter's id (`isMatter`: a lone observation's matter has the observation's id) is a matter, as `fetch` opens it.
 */
export const lifeLinksOf = (
  context: string | null,
  isMatter: (id: string) => boolean = () => false
) =>
  lifeRefsOf(context ?? "").flatMap((ref) => {
    const r = parseRef(ref);
    return "error" in r
      ? []
      : [{ kind: isMatter(ref) ? "matter" : r.kind, ref }];
  });

/** Why a deletion may not name a ref: a person, a project or an area is his directory's, and that has its own door. */
export const deletionRefusalOf = (id: string) =>
  SUBJECT_PREFIX.test(id)
    ? `${id} is his directory's, not memory's: change it with change_directory_entry`
    : null;
