import { z } from "zod";

// An answer icon (docs/glossary.md): the icon on one answer of a card, one key of this fixed set; the phone maps a key
// to its symbol and draws nothing for a key it doesn't know. An agent picks one for an option (`Option.icon`), never
// one of Life's acts (`LIFE_ACT_ICONS`): those say what Life itself does on his tap, so nothing else looks like them.
// A key is stored on an asked card's option, so removing or renaming one is a rename with its migration.

/** Life's acts: it sends the draft, writes the event, closes the step or looks for it done, starts an agent. */
export const LIFE_ACT_ICONS = [
  "send",
  "add_to_calendar",
  "done",
  "agent",
] as const;

/** Every key: Life's acts, then the ones an agent may pick (an array: the formatter sorts object keys). */
export const ANSWER_ICONS = [
  ...LIFE_ACT_ICONS,
  "start",
  "no",
  "later",
  "drop",
  "open",
  "person",
  "people",
  "organization",
  "link",
  "hide",
  "date",
  "place",
] as const;

export const AnswerIcon = z.enum(ANSWER_ICONS);
export type AnswerIcon = z.infer<typeof AnswerIcon>;

/** Whether `icon` is one of Life's acts, which only Life draws. */
export const isLifeActIcon = (icon: string) =>
  (LIFE_ACT_ICONS as readonly string[]).includes(icon);

/** An option's marks, as far as its icon goes (a decision's `Option`, Life's own `CheckOption`). */
interface Marked {
  adds?: true;
  ends?: "matter" | "step";
  icon?: AnswerIcon;
  looks?: true;
  outgoing?: true;
}

/**
 * The one rule for an answer's icon: Life's act when the option is one (sends, adds, looks), else the icon given (the
 * agent's, or Life's own pick on its cards), else the done check when it closes a step or matter. An `ends` option
 * keeps a given icon so a plain drop ("Drop it", which closes the matter unwanted) reads as one, not as done.
 */
export const answerIconOf = (o: Marked): AnswerIcon | undefined =>
  (o.outgoing && "send") ||
  (o.adds && "add_to_calendar") ||
  (o.looks && "done") ||
  o.icon ||
  (o.ends && "done") ||
  undefined;
