import { digest } from "../core/hash";
import type { Correction, Cut } from "../records/observation";

// A deletion (docs/glossary.md): his word that something goes from memory, kept as one line of corrections.jsonl (kind
// `deleted`) and applied by every read of the words it removed: a ref's line is gone whole, a cut's words are blanked, and
// what was read from them is gone too (`isDeleted`). Nothing of the deleted text is ever stored: a cut keeps its places and
// the digest of what was there. `dependentsOf` is the one resolver of what a deletion reaches in the stored layers; the
// steps that write it (the door) hand it what it is shown, so this file reads nothing and nothing imports it back.

/** Every deletion he recorded, as the reads apply them. */
export interface Deletions {
  /** The cuts of each ref, in the order he recorded them. */
  cuts: ReadonlyMap<string, Cut[]>;
  /** Each derived read shown the deleted words (`shownKeyOf`), with the instant of that deletion. */
  hidden: ReadonlyMap<string, string>;
  /** A unit's hash as it stood before a deletion of its words: what was read under it is gone, never history. */
  oldHashes: ReadonlySet<string>;
  /** The refs whose line is gone whole (a unit, a fact, an episode, a message, a turn, a file, a matter, a card). */
  refs: ReadonlySet<string>;
}

/** No deletion at all: a process's, a test's, or a read of words nothing touched. */
export const NO_DELETIONS: Deletions = {
  cuts: new Map(),
  hidden: new Map(),
  oldHashes: new Set(),
  refs: new Set(),
};

/** Every deletion among his corrections, as the reads apply them. Pure. */
export function deletionsOf(corrections: readonly Correction[]): Deletions {
  const refs = new Set<string>();
  const oldHashes = new Set<string>();
  const cuts = new Map<string, Cut[]>();
  const hidden = new Map<string, string>();
  for (const c of corrections) {
    if (c.kind !== "deleted") {
      continue;
    }
    for (const ref of c.refs) {
      refs.add(ref);
    }
    for (const hash of c.oldHashes) {
      oldHashes.add(hash);
    }
    for (const cut of c.cuts) {
      cuts.set(cut.ref, [...(cuts.get(cut.ref) ?? []), cut]);
    }
    for (const key of c.shown) {
      hidden.set(key, [hidden.get(key) ?? "", c.at].sort().at(-1) as string);
    }
  }
  return { cuts, hidden, oldHashes, refs };
}

/**
 * A cut of the words `from` to `to` in `text`, made when he said they go: their places and the digest of what was there
 * (16 hex), checked again at every read (`blankCuts`).
 */
export const cutOf = (
  ref: string,
  text: string,
  from: number,
  to: number
): Cut => ({
  digest: digest("sha256", text.slice(from, to), 16),
  from,
  ref,
  to,
});

const BLANK = /\S/g;

/**
 * `text` with `cuts` blanked: a space where a word was, its newlines kept, so the places of everything after it hold.
 * Only a cut whose digest is the words at its places applies; one that does not (the text changed since) blanks nothing.
 */
export function blankCuts(text: string, cuts: readonly Cut[] = []): string {
  let blanked = text;
  for (const cut of cuts) {
    if (
      cut.from < cut.to &&
      cut.to <= blanked.length &&
      digest("sha256", blanked.slice(cut.from, cut.to), 16) === cut.digest
    ) {
      blanked =
        blanked.slice(0, cut.from) +
        blanked.slice(cut.from, cut.to).replace(BLANK, " ") +
        blanked.slice(cut.to);
    }
  }
  return blanked;
}

/**
 * The words a read takes of one line: none at all when the line is gone whole, else its cuts blanked. The one way a
 * line's words come in (`words.ts`'s `transcripts`, `units.ts`'s `readSourceEventsNow`).
 */
export const deletedWordsOf = (
  ref: string,
  text: string,
  d: Deletions
): string => (d.refs.has(ref) ? "" : blankCuts(text, d.cuts.get(ref)));

/** The key a derived read is known by in a deletion's `shown`: a persona, a history's month or story, a situation. */
export const shownKeyOf = {
  history: (ref: string, month: string) => `history:${ref}:${month}`,
  persona: (ref: string) => `persona:${ref}`,
  situation: (ref: string) => `situation:${ref}`,
};

/**
 * Whether a derived read was shown words he deleted (`built` is when it was made): it shows again only once it is redone
 * after that deletion, which its readers get by hiding it now (an absent one is due, `isDue`).
 */
export const isHiddenUntilRedone = (
  key: string,
  built: string,
  d: Deletions
) => {
  const at = d.hidden.get(key);
  return at !== undefined && built < at;
};

/** What a record read from words rests on: its own id, the line it cites, its unit and the unit's hash then. */
export interface ReadFrom {
  id: string;
  ref: string;
  unit?: string;
  unitHash?: string;
}

/**
 * Whether a record read from those words is gone: he deleted it, the line it cites or its unit, or it was read under a
 * unit hash a deletion changed (its words went, so what was read from them is gone, never history).
 */
export const isDeleted = (r: ReadFrom, d: Deletions) =>
  d.refs.has(r.id) ||
  d.refs.has(r.ref) ||
  (r.unit !== undefined && d.refs.has(r.unit)) ||
  (r.unitHash !== undefined && d.oldHashes.has(r.unitHash));

/**
 * The stored layers a deletion is worked out over, as the door reads them: ids and refs only, never a text, so nothing of
 * what is deleted is read here.
 */
export interface DeletionLayers {
  /** The cards, with the step each rides on (`subject`), when it names one. */
  cards: { id: string; subject?: string }[];
  /** The link lines: the step each ends (`earlier`) and the record that ends it (`later`). */
  links: { earlier: string; later: string }[];
  /** The matters and their steps. */
  matters: { id: string; steps: string[] }[];
  /** The facts, with the line they cite and their unit. */
  observations: { id: string; source: string; unit: string }[];
  /** The stored reads, by their keys and the keys they were shown (a reply's messages, a summary's turns). */
  replies: { id: string; refs: string[] }[];
  /** The derived reads shown units: a persona, a history's month, a situation, and the units each was shown. */
  shown: { id: string; units: string[] }[];
  /** The to-do items' ledger keys. */
  todoItems: string[];
  /** The units and the refs inside them (messages, turns). */
  units: { id: string; refs: string[] }[];
}

/** What a deletion reaches, by layer: what the door then hides, withdraws, reads again or removes from his list. */
export interface Dependents {
  /** The cards to withdraw. */
  cards: string[];
  /** The facts read from the deleted words. */
  facts: string[];
  /** What he said of those facts: nothing new is read from them. */
  links: string[];
  /** The matters holding a deleted step. */
  matters: string[];
  /** The stored reads of them, which no longer match and are asked again. */
  replies: string[];
  /** The derived reads shown them, which are redone before they show again. */
  shown: string[];
  /** The to-do items to remove from his list (`changeTodoItem`). */
  todoItems: string[];
  /** The units holding the deleted words, read again. */
  units: string[];
}

/**
 * What deleting `refs` reaches, in the stored layers it is shown: a message or a turn reaches its unit, the unit its facts,
 * a fact its matter, its links and the cards on it; a matter reaches the cards on its steps and the reads shown them; a
 * to-do item's key is removed from his list; a stored read or a derived one shown them is no longer good. Pure.
 */
export function dependentsOf(
  refs: readonly string[],
  layers: DeletionLayers
): Dependents {
  const asked = new Set(refs);
  const units = layers.units.filter(
    (u) => asked.has(u.id) || u.refs.some((r) => asked.has(r))
  );
  const unitIds = new Set(units.map((u) => u.id));
  const facts = layers.observations.filter(
    (o) => asked.has(o.id) || asked.has(o.source) || unitIds.has(o.unit)
  );
  const steps = new Set([...asked, ...facts.map((o) => o.id)]);
  const matters = layers.matters.filter((m) =>
    m.steps.some((s) => steps.has(s))
  );
  return {
    cards: layers.cards
      .filter((c) => c.subject === undefined || steps.has(c.subject))
      .map((c) => c.id),
    facts: facts.map((o) => o.id),
    links: layers.links
      .filter((l) => steps.has(l.earlier) || steps.has(l.later))
      .map((l) => l.earlier),
    matters: matters.map((m) => m.id),
    replies: layers.replies
      .filter((r) => r.refs.some((x) => asked.has(x)))
      .map((r) => r.id),
    shown: layers.shown
      .filter((s) => s.units.some((u) => asked.has(u) || unitIds.has(u)))
      .map((s) => s.id),
    todoItems: layers.todoItems.filter((t) => asked.has(t)),
    units: [...unitIds],
  };
}
