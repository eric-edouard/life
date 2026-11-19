// Each kind of check (`checks.ts`): its group, and for Life's own guesses their title, context and options. An option's
// label is his app's button, a few words for him; what choosing it does, in words a model reads, is in `answer_check`'s
// description (`host/http/mcp.ts`), and what his answer must carry is `takes`.

/** What a check is, for counting: a decision, an ending, a new matter, a guessed person, a Contacts card Life cannot place (`contacts card`), a name it cannot place, a voice. */
export type CheckGroup =
  | "decision"
  | "ending"
  | "new matter"
  | "guessed person"
  | "contacts card"
  | "name"
  | "voice";

/**
 * One answer he can give: its id, as `answer_check` takes it; its label, his button's words; whether it sends, pays,
 * books, deletes or changes something (`outgoing`); and what his answer must carry besides it (`takes`): who it is as
 * `person` (`person:<id>`), a voice's someone known as `person` or a new person's `name`, his words as `note`; null:
 * nothing.
 */
export interface CheckOption {
  id: string;
  label: string;
  outgoing?: true;
  takes: "note" | "person" | "person or name" | null;
}

/** Each kind of Life's guesses: what it is trying to do (its title), why it asks (its context), and what he can answer, its guess first (`answerCheck` writes it). */
export const LIFE_CHECKS = {
  "contacts card": {
    context: null,
    options: [
      { id: "same-person", label: "It is this person", takes: "person" },
    ],
    title: "Place a Contacts card",
  },
  ending: {
    context: "A later step seems to show it done.",
    options: [
      { id: "outdated", label: "Done", takes: null },
      { id: "false", label: "Not done", takes: null },
    ],
    title: "Close what is done",
  },
  "guessed person": {
    context: null,
    options: [
      { id: "this-is", label: "It is them", takes: null },
      { id: "not-this-person", label: "Not them", takes: null },
      {
        id: "same-person",
        label: "Someone Life already knows",
        takes: "person",
      },
    ],
    title: "Know who someone is",
  },
  name: {
    context: null,
    options: [{ id: "this-is", label: "It is this person", takes: "person" }],
    title: "Place a name",
  },
  "new matter": {
    context: "Nothing blocks its next step: an agent could move it now.",
    options: [
      { id: "start", label: "Start", takes: null },
      { id: "edit-goal", label: "Edit goal", takes: "note" },
      { id: "dismiss", label: "Dismiss", takes: null },
    ],
    title: "Life found a new matter",
  },
  voice: {
    context:
      "Heard in conversations: who it is goes to every turn of this voice.",
    options: [
      {
        id: "this-is",
        label: "It is this person",
        takes: "person or name",
      },
      { id: "not-anyone-i-know", label: "A stranger", takes: null },
      { id: "media", label: "TV or video", takes: null },
      { id: "not-relevant", label: "Don't care", takes: null },
    ],
    title: "Name a voice",
  },
} as const satisfies Record<
  Exclude<CheckGroup, "decision">,
  { context: string | null; options: CheckOption[]; title: string }
>;
