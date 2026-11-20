import { SourceName } from "../core/names";
import { SUBJECT_PREFIX, UnitId } from "../records/fields";
import { MatterId } from "../records/matter";
import { ObservationId } from "../records/observation";
import { parseTurnRef } from "../sources/lifelog";
import { isAskPage } from "./card-request";
import { parseReadPartRef, type ReadPartRef } from "./read-part";

// The one grammar of what `fetch` opens (`openById`), which a card's `life:` links name and the phone is told the kind of
// (`lifeLinksOf`). Pure: whether a ref names something that exists is its kind's reader's to say (`find-refs.ts`).

/** A ref `fetch` takes, by kind; any other id is a conversation's (a lifelog conversation or an imported one). */
export type Ref = { id: string } & (
  | { kind: "ask" }
  | { kind: "conversation" }
  | { kind: "file"; file: string }
  | { kind: "matter" }
  | { kind: "message"; message: string; source: SourceName }
  | { kind: "observation" }
  | { kind: "person"; read: ReadPartRef }
  | { jobId: string; kind: "turn"; turnIndex: number }
  | { kind: "unit" }
);
export type RefKind = Ref["kind"];

const LIFE = "life:";
const MESSAGE = "msg:";
/** A to-do item's key: a lone one's matter has its id. */
const TODO_ITEM = /^entry_[0-9a-f]{12}$/;
const FILE = "file:";

/** A ref's kind and parts, or why it is malformed. A message is `msg:<source>|<id>` (`eventKey`), split at the first `|`. */
export function parseRef(id: string): Ref | { error: string } {
  if (isAskPage(id)) {
    return { id, kind: "ask" };
  }
  if (SUBJECT_PREFIX.test(id)) {
    const read = parseReadPartRef(id);
    return "error" in read ? read : { id, kind: "person", read: read.ref };
  }
  if (id.startsWith(MESSAGE)) {
    const at = id.indexOf("|");
    const source = SourceName.safeParse(id.slice(MESSAGE.length, at));
    return at > 0 && source.success && at < id.length - 1
      ? { id, kind: "message", message: id.slice(at + 1), source: source.data }
      : { error: `"${id}" is not a message ref (msg:<source>|<message id>)` };
  }
  if (id.startsWith(FILE)) {
    return id.length > FILE.length
      ? { file: id.slice(FILE.length), id, kind: "file" }
      : { error: `"${id}" is not a file ref (file:<ref>)` };
  }
  const turn = parseTurnRef(id);
  return (
    ((MatterId.safeParse(id).success || TODO_ITEM.test(id)) && {
      id,
      kind: "matter",
    }) ||
    (ObservationId.safeParse(id).success && { id, kind: "observation" }) ||
    (UnitId.safeParse(id).success && { id, kind: "unit" }) ||
    (turn && { id, kind: "turn", ...turn }) ||
    (id.trim() === id && id !== ""
      ? { id, kind: "conversation" }
      : { error: `"${id}" is not a ref` })
  );
}

/** The `life:` link destinations of a Markdown text, as a Markdown reader finds them (never in code), percent-decoded, each once. */
export function lifeRefsOf(markdown: string) {
  const refs = new Set<string>();
  Bun.markdown.render(markdown, {
    link: (_: unknown, { href }: { href: string }) => {
      if (href.startsWith(LIFE)) {
        try {
          refs.add(decodeURIComponent(href.slice(LIFE.length)));
        } catch {
          refs.add(href.slice(LIFE.length));
        }
      }
      return "";
    },
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
