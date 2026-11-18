// A status card (the status snapshot's unit, `snapshot.ts`): its shape and the rule that picks its tone. A card built
// outside the snapshot (the desk's, `desk-card.ts`) uses the same.

export type Tone = "bad" | "busy" | "idle" | "ok" | "teal" | "warn";

/** One line of a card: a value, or an instant the app shows as "3 min ago". Never his words, never an error's text. */
export interface Fact {
  at?: string | null;
  label: string;
  value?: string;
}

export interface Card {
  /** A sentence to paste into a Claude session, when the part is in trouble. */
  ask?: string;
  /** When its headline happened: the app adds "3 h ago". */
  at?: string | null;
  /** His words and errors' text on the card: hidden while the app's Show content is off. */
  content?: string[];
  facts: Fact[];
  group: string;
  headline: string;
  id: string;
  name: string;
  /** A running processing run's processing steps and where it is. */
  processingSteps?: { name: string; state: "done" | "now" | "todo" }[];
  tone: Tone;
  word: string;
}

export const ASK = (what: string) =>
  `Life's status shows ${what}: look into it.`;

/** The first state whose condition holds: a card's tone and word (and its ask) by precedence. */
export const firstOf = (
  ...rules: [
    boolean | undefined,
    Pick<Card, "ask" | "tone" | "word"> & Partial<Pick<Card, "headline">>,
  ][]
) =>
  rules.find(([holds]) => holds)?.[1] ?? {
    tone: "idle" as Tone,
    word: "unknown",
  };
