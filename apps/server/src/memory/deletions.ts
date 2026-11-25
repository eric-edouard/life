import { digest } from "../core/hash";
import type { Correction, Cut } from "../records/observation";
import type { SourceEvent } from "../records/source";
import { parseTurnRef } from "../sources/lifelog";

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

/**
 * A ref as a deletion knows it: a turn by its recording and index alone (`job:turn`), never its instant, so the same turn
 * is found whatever `at` a reader or his card spelled it with.
 */
export const refKeyOf = (ref: string) => {
  const t = parseTurnRef(ref);
  return t ? `${t.jobId}:${t.turnIndex}` : ref;
};

/** Whether he deleted `ref`'s line whole (a turn matched by `refKeyOf`, however either side spelled it). */
export const isGone = (ref: string, d: Deletions) =>
  d.refs.has(ref) || d.refs.has(refKeyOf(ref));

/** The cuts he made on `ref`, in the order he recorded them (a turn matched as `isGone` matches it). */
export const cutsOn = (ref: string, d: Deletions) =>
  d.cuts.get(ref) ?? d.cuts.get(refKeyOf(ref)) ?? [];

/** Whether he cut words inside `ref` (its line stays, some of its words gone): a text built beside it, a clip of it, shows none. */
export const isCut = (ref: string, d: Deletions) => cutsOn(ref, d).length > 0;

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
      refs.add(refKeyOf(ref));
    }
    for (const hash of c.oldHashes) {
      oldHashes.add(hash);
    }
    for (const cut of c.cuts) {
      const ref = refKeyOf(cut.ref);
      cuts.set(ref, [...(cuts.get(ref) ?? []), cut]);
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

/** A message's ref as a deletion names it (`msg:<source>|<id>`, `refs.ts`). */
export const messageRefOf = (source: string, id: string) =>
  `msg:${source}|${id}`;

/** A file's ref as a deletion names it (`file:<ref>`, `refs.ts`). */
export const fileRefOf = (ref: string) => `file:${ref}`;

/**
 * The words a read takes of one line: none at all when the line is gone whole, else its cuts blanked. The one way a
 * line's words come in (`words.ts`'s `transcripts`, `sources.ts`'s `deletedReadOf`).
 */
export const deletedWordsOf = (
  ref: string,
  text: string,
  d: Deletions
): string => (isGone(ref, d) ? "" : blankCuts(text, cutsOn(ref, d)));

/**
 * `events` with what he deleted applied: a message whose words are gone whole is dropped, a cut's words blanked. The one
 * way a source's messages come in, the send paths aside (`draft-send.ts`, which must send exactly what he approved).
 */
export const deletedEventsOf = (
  name: string,
  events: SourceEvent[],
  d: Deletions
) =>
  events.flatMap((e) => {
    const ref = messageRefOf(name, e.id);
    return isGone(ref, d) || isGone(e.id, d)
      ? []
      : [
          {
            ...e,
            text: blankCuts(e.text, [...cutsOn(ref, d), ...cutsOn(e.id, d)]),
          },
        ];
  });
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
  isGone(r.id, d) ||
  isGone(r.ref, d) ||
  (r.unit !== undefined && isGone(r.unit, d)) ||
  (r.unitHash !== undefined && d.oldHashes.has(r.unitHash));

/**
 * The stored layers a deletion is worked out over, as the door reads them: ids and refs only, never a text, so nothing of
 * what is deleted is read here.
 */
export interface DeletionLayers {
  /** The cards, with the step each rides on (`subject`) and the refs its links name (`refs`), when it has any. */
  cards: { id: string; subject?: string; refs?: string[] }[];
  /** The matters and their steps. */
  matters: { id: string; steps: string[] }[];
  /** The facts, with the line they cite and their unit. */
  observations: { id: string; source: string; unit: string }[];
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
  /** The matters holding a deleted step. */
  matters: string[];
  /** The derived reads shown them, which are redone before they show again. */
  shown: string[];
  /** The to-do items to remove from his list (`changeTodoItem`). */
  todoItems: string[];
  /** The units holding the deleted words, read again. */
  units: string[];
}

/**
 * What deleting `refs` reaches, in the stored layers it is shown: a message or a turn reaches its unit, the unit its facts,
 * a fact its matter and the cards on it; a matter reaches the cards on its steps and the to-do items among them; a to-do
 * item's key is removed from his list, and a derived read shown them is no longer good. A card is withdrawn when he names
 * it, or when a step or a link of it is reached. Pure.
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
  // A matter he names is reached by its own id; another by a step of it.
  const matters = layers.matters.filter(
    (m) => asked.has(m.id) || m.steps.some((s) => steps.has(s))
  );
  // A matter he deleted takes its to-do items with it: his list's steps go as his Drop removes them.
  const removed = new Set([
    ...asked,
    ...matters.filter((m) => asked.has(m.id)).flatMap((m) => m.steps),
  ]);
  return {
    cards: layers.cards
      .filter(
        (c) =>
          asked.has(c.id) ||
          (c.subject !== undefined && steps.has(c.subject)) ||
          (c.refs ?? []).some((r) => steps.has(r))
      )
      .map((c) => c.id),
    facts: facts.map((o) => o.id),
    matters: matters.map((m) => m.id),
    shown: layers.shown
      .filter((s) => s.units.some((u) => asked.has(u) || unitIds.has(u)))
      .map((s) => s.id),
    todoItems: layers.todoItems.filter((t) => removed.has(t)),
    units: [...unitIds],
  };
}

/**
 * Whether a copy of his words outside memory holds what a deletion removes: one of its `texts` holds the deleted words
 * (by the quote check), or one of its `refs` is a deleted ref. Pure; made by `copyMatchOf`.
 */
export type HoldsDeleted = (
  texts: readonly (string | null)[],
  refs: readonly string[]
) => boolean;
