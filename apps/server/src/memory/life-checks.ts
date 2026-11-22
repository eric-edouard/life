// Each kind of check (`checks.ts`): its group, and for Life's own guesses their title, context and options. An option's
// label is his app's button, a few words for him; what choosing it does, in words a model reads, is in `answer_check`'s
// description (`host/http/mcp.ts`), and what his answer must carry is `takes`.

import type { z } from "zod";
import type { CheckGroup } from "../core/names";
import type { NamingQueueItem } from "../sources/lifelog-voices";
import type { PlanStep } from "./card-request";
import type { Decision, doneSeenShownOf } from "./decision-lines";
import type { StoredDraft } from "./draft";
import type { AgentHold } from "./held-matters";
import type { needsShownOf } from "./needs";
import type { Party } from "./party";
import type { RefKind } from "./refs";

/**
 * One answer he can give: its id, as `answer_check` takes it; its label, his button's words; whether it acts outside
 * Life, sending, paying, booking, deleting or changing something (`outgoing`), closes the card's step or matter in
 * Life (`ends`, a decision's), or makes Life look for the step done (`looks`, a decision's); and what his answer must carry besides it (`takes`): who it is as
 * `person` (`person:<id>`), someone known as `person` or a new person's `name` (a voice's, or someone he adds to his
 * directory), his words as `note`; null: nothing.
 */
export interface CheckOption {
  ends?: "matter" | "step";
  id: string;
  label: string;
  looks?: true;
  outgoing?: true;
  /** On a plan card's two options: `start` the plan, or `decline` it (the option role). */
  role?: "decline" | "start";
  takes: "note" | "person" | "person or name" | null;
}

/** One sentence as it was said: who (null: not known), to whom (the chat or thread), on which channel, when (a day or an instant), and its words, verbatim. */
export interface Said {
  at: string | null;
  by: string | null;
  channel: string | null;
  text: string;
  to: string | null;
}

/** Each kind of Life's guesses: what it is trying to do (its title), why it asks (its context), and what he can answer, its guess first (`answerCheck` writes it). */
export const LIFE_CHECKS = {
  // His Yes adds the person to the organization in his directory, with the role the question shows; his No is never asked again.
  "at organization": {
    context: null,
    options: [
      { id: "yes", label: "Yes", takes: null },
      { id: "not-at-organization", label: "No", takes: null },
    ],
    title: "Link someone to an organization",
  },
  "contacts card": {
    context: null,
    options: [
      { id: "same-person", label: "Someone else…", takes: "person or name" },
    ],
    title: "Place a Contacts card",
  },
  ending: {
    context: "A later step seems to show it done.",
    options: [
      { id: "outdated", label: "Yes, done", takes: null },
      { id: "false", label: "Not yet", takes: null },
    ],
    title: "Close what is done",
  },
  "guessed person": {
    context: null,
    options: [
      { id: "this-is", label: "Yes", takes: null },
      { id: "not-this-person", label: "No", takes: null },
      { id: "same-person", label: "Someone else…", takes: "person or name" },
    ],
    title: "Know who someone is",
  },
  name: {
    context: null,
    // "Organization" takes nothing more: his `name` for it (default the card's) and his `note` (what it is to him) are optional.
    options: [
      { id: "this-is", label: "Someone else…", takes: "person or name" },
      { id: "organization", label: "Organization", takes: null },
      { id: "not-relevant", label: "I don't care", takes: null },
    ],
    title: "Place a name",
  },
  "new matter": {
    context: "Nothing blocks its next step: an agent could move it now.",
    options: [
      { id: "start", label: "Start", takes: null },
      { id: "edit-goal", label: "Edit goal", takes: "note" },
      { id: "dismiss", label: "No", takes: null },
    ],
    title: "Life found a new matter",
  },
  "same person": {
    context: "They go by the same whole name; nothing Life holds joins them.",
    options: [
      { id: "same-person", label: "Same person", takes: null },
      { id: "not-this-person", label: "Different people", takes: null },
    ],
    title: "Join one person",
  },
  voice: {
    context:
      "Heard in conversations: who it is goes to every turn of this voice.",
    // The three it offers; "Yes" only when a guess is in use. `not-anyone-i-know` and `media` stay accepted writers only (`answer-check.ts`: installed builds send them).
    options: [
      { id: "is-them", label: "Yes", takes: null },
      {
        id: "this-is",
        label: "Someone else…",
        takes: "person or name",
      },
      { id: "not-relevant", label: "Don't name", takes: null },
    ],
    title: "Name a voice",
  },
  // A matter's step that is his: "Hand to an agent" only while an agent could take it (`checks.ts` drops it otherwise).
  "your move": {
    context: "A step of yours is open on this matter.",
    options: [
      { ends: "step", id: "done", label: "Mark as done", takes: null },
      { id: "start", label: "Hand to an agent", takes: null },
      { id: "not-now", label: "Not now", takes: null },
      { ends: "step", id: "drop", label: "Drop", takes: null },
    ],
    title: "Your move",
  },
} as const satisfies Record<
  Exclude<CheckGroup, "decision">,
  { context: string | null; options: CheckOption[]; title: string }
>;

export type CheckKind =
  | "decision"
  | "ending"
  | "new matter"
  | "person"
  | "voice"
  | "your move";
/** A matter as a card names it: its id, its name, and `important` when he marked it. */
export interface CheckMatter {
  id: string;
  important?: true;
  name: string;
}

/**
 * One thing waiting on his word, the same shape for every kind: Life's guesses and agents' decisions alike. A field
 * a kind has nothing for is null or empty. Only open checks exist: his answer and what came of it are kept by each
 * kind's own store (`decisionsNow`, the fact-check answers, the corrections).
 */
export interface Check {
  /** The names and handles the question is about, as his answer takes them (`nameOrHandle`); none but a person's. */
  about: string[];
  /** The registered agent that asked a decision (the desk's `agt_…`, `Decision.agent`), which tells apart the agents asking as `desk`; null for every other check. */
  agent?: string | null;
  /** Who asks: `life` for Life's own guesses, else the agent's pairing or `desk`. */
  asker: string;
  /** When it was asked; null for Life's guesses (worked out when read). */
  at: string | null;
  /** His complaint on this card's cause at work with the caretaker (received, its assignment open, its event not dropped): the complaint (an ask id), since when, and the caretaker's own line when only this complaint is its work; absent: none. Such a card no longer blocks (`urgencyOf`). */
  beingFixed?: BeingFixed;
  /** The spans of recording a card plays (`audio` is what the app plays from lifelog): a voice's, newest first as lifelog gives them, or a spoken name's one clip of its sentence (`check-sentences.ts`); none for every other kind. */
  clips: {
    at: string | null;
    audio: { end: number; jobId: string; start: number } | null;
    text: string;
    until: string | null;
    /** Its words as lifelog times them (`TimedWords`): [start, end, length] each, in ms from the clip's start and UTF-16 units of `text` with the spacing before it, for lighting them while it plays. */
    words: number[][];
  }[];
  /** The guess about who a decision's draft goes to, when Life only guesses who that is: asked beside it, answered on its own; none for every other check. */
  confirm: Check[];
  /** A Contacts card's own name and handles, from the one `ContactNow`; null for every other kind. Never a network identity (a card has no chat). */
  contactsCard?: { handles: string[]; name: string } | null;
  /** Why it asks, what was tried, what it rests on: folded on his card, in Markdown. An agent's words, or Life's own for its guesses, with the words a guess rests on quoted (`checksOf`). */
  context: string | null;
  /** By when he answers; null: no deadline. */
  deadline: string | null;
  /** Life's outcome on a decision whose step it looks for (`doneSeenBy`): while the card is open, only a look that found nothing (`not_found`) with Life's words; absent on every other kind or when it never looked. */
  doneSeen?: ReturnType<typeof doneSeenShownOf>;
  /** How Life sees a decision's step done now (`doneSeenByOf`): `payment`, or `tap` (only his word); absent on every other kind. */
  doneSeenBy?: "payment" | "tap";
  /** The exact message he approves (to whom, on which channel, its text), shown in full; null: none. */
  draft: StoredDraft | null;
  /** On a plan card: what its plan was gathered from, one line (the source chip), which opens its `context`; null on a decision with none; absent on every other kind. */
  gathered?: { text: string } | null;
  /** A new matter's goal, the one his Start hands the agent (the question words it too); null for every other kind. */
  goal: string | null;
  group: CheckGroup;
  /** A draft card's chat as his card heads it (`draftHeadOf`): its network and its name; absent on every other check. */
  head?: { name: string; network: string } | null;
  /** Whether a decision is a plan card: it gives `plan`, its steps; absent on every other kind. */
  isPlan?: boolean;
  kind: CheckKind;
  /** The `life:` links of its `context`, each with its kind (`lifeLinksOf`): worked out when read, never stored. */
  lifeLinks: { kind: RefKind; ref: string }[];
  /** Who it may be, as parties (`partyOf`): a voice's likely people, a Contacts card's candidates, the people who go by a name; none for other kinds. */
  likelyPeople: Party[];
  /** Where to look, as asked (a registered agent's: the session it asked from first; what "Open in" opens is `session`). */
  links: string[];
  /** The matter it belongs to: the one holding its `subject`, else its `ref` (`matterFinderOf`), closed ones too (an ending check is about a matter that reads probably done), `important` when he marked it; null: none. */
  matter: CheckMatter | null;
  /** On Life's own cards only (none of an agent's, the caretaker's included): `cause`, what its guess rests on (`causeOf`), which shows his "Wrong…" (to Tell Life) and marks it being fixed; null on an agent's. */
  misread?: { cause: string } | null;
  /** What he needs in hand to do a decision's step, each with Life's `line` of it, in the order to show them; absent on every other kind. */
  needs?: ReturnType<typeof needsShownOf>;
  /** A decision whose draft his last answer did not send (nothing went): when, why, and whether the same tap could work again; null: none. */
  notSent: {
    at: string;
    canRetry: boolean;
    reason: string;
    /** The message that refused the send ("someone wrote since"): when, by whom, its words; null for any other refusal. */
    wrote: { at: string; by: string; text: string } | null;
  } | null;
  /** Every open matter it rides on, by name and id (`ridesOn.matterIds`). */
  onMatters: CheckMatter[];
  /** The option the agent takes when he does not answer; null: none is taken (Life keeps using its guess, never writing it). */
  onSilence: string | null;
  /** What he can answer (`CheckOption`: his button's label and what his answer takes); with two or more, the first is the one recommended (Life: its guess). Besides them he can always answer in his own words (a decision's `note`; on Life's own cards, his complaint, `misread`). */
  options: CheckOption[];
  /** A plan card's steps, in order (`PlanStep`); null on a decision with none (an older plan card: its plan is in `context`); absent on every other kind. */
  plan?: z.infer<typeof PlanStep>[] | null;
  /** The pre-ticked answer: the option id a bulk card starts this row ticked with (`preTickedOf`), worked out when read, never stored; null or absent: unticked. */
  preTicked?: string | null;
  /** What he decides, in one sentence (a guess's worded by a template, no model). */
  question: string;
  /** What his answer acts on: a decision's id, an observation id (ending), a person ref (a guessed person, a card), or `name:<nameKey>` (a name not placed). */
  ref: string;
  /** A decision asked after another agent's card held its draft's chat for `CONTEST_WAIT`: that older card's id ("Replaces an older draft"; his Send withdraws it); null: none. Absent on every other kind. */
  replaces?: string | null;
  /** What uses it today, counted from what is stored. */
  ridesOn: {
    /** The ids of those matters (`matters` counts them): `checksOnMatterOf` finds a matter's checks by them. */
    matterIds: string[];
    // ponytail: remove `matters` once the phone build that reads `matterIds` ships; installed builds need it to decode.
    matters: number;
    observations: number;
    pages: number;
  };
  /** The sentence the ask is about, as said: a name's own line (verbatim), the open step of an ending, the step a new matter began with; null for every other kind. */
  said: Said | null;
  /** A decision's session, what its "Open in" opens: a registered agent's card, its holder's session now (host's `cardHoldersOf`), never a link it was asked with; any other ask, its first link; absent when none, and on every other kind. */
  session?: string;
  /** What follows the open step an ending check asks about, "since then": what makes Life think it is done, with who said it and when; null for every other kind. */
  since: Said | null;
  /** What in his life it belongs to, when not `ref` itself: a matter step, `project:<id>`, `area:<id>`; for a voice, the person lifelog suggests; null: none. */
  subject: string | null;
  /** What it is trying to do, in one line. */
  title: string;
}

/** A card whose cause his complaint is at work on (`Check.beingFixed`). */
export interface BeingFixed {
  ask: string;
  /** The caretaker's open card's `context`, beside its question (`line`); null with no card. */
  context: string | null;
  /** The caretaker's open card's question on that complaint's assignment; null with none (the plain "fixing this"). */
  line: string | null;
  since: string;
}

/** The guess an ending check's answer stores in the fact-check line (the card asks "Is this done?" with the step's own sentence). */
export const endingGuessOf = (step: string) =>
  `Life thinks this is done: ${step}`;

/**
 * The pre-ticked answer (`Check.preTicked`): the option a bulk card starts a row ticked with; he unticks the wrong ones.
 * An ending reads probably done; a voice whose guess is in use (`subject`) and whose sound alone names them (lifelog's
 * `isLikely`), "Yes"; a voice of no one Life knows (lifelog's `new_person`: a known person's own name is never in `name`), heard in
 * one conversation with no name heard, "Don't name"; a guessed person, "Yes"; two accounts that may be one person, "Same
 * person" (the bulk card of guesses draws these as Yes or No rows, answered one by one); null for anything else.
 */
export function preTickedOf(
  c: Pick<Check, "kind"> & Partial<Pick<Check, "group" | "subject">>,
  voice?: Pick<NamingQueueItem, "conversations" | "isLikely" | "kind" | "name">
): string | null {
  if (c.kind === "ending") {
    return "outdated";
  }
  // A guess Life already uses, and two accounts that may be one person: his "Yes" is the answer a row starts from.
  if (c.group === "guessed person") {
    return "this-is";
  }
  if (c.group === "same person") {
    return "same-person";
  }
  if (c.kind !== "voice" || !voice) {
    return null;
  }
  if (c.subject && voice.isLikely) {
    return "is-them";
  }
  return voice.kind === "new_person" && voice.conversations === 1 && !voice.name
    ? "not-relevant"
    : null;
}

/** Whether a check asks if a step is done (never in the nightly email). */
export const isEndingKind = (c: Pick<Check, "kind">) => c.kind === "ending";

/** Open cards by id, each as its holder's: the agent and its session now, if any. */
export type CardHolders = Readonly<
  Record<string, { agent: string; session?: string }>
>;

/** What registered agents hold, as the inbox reads it from the desk: a cheap stamp for the key (host's `heldStampOf`), and the facts (`heldByAgents`), read only when the list is read again; null facts when the desk can't be read then. And his complaints the caretaker holds (host's `complaintsAtWork`: a few rows, in the stamp), as cards show them over the decisions read (host's `beingFixedOf`). */
export interface HeldRead {
  /** Each of the open `decisions` a registered agent asked, as its holder's, with that agent's session now (host's `cardHoldersOf`): given the one list the inbox reads, so a card asked meanwhile is never shown without it. */
  cardHolders?: (decisions: readonly Decision[]) => CardHolders;
  complaints?: (decisions: readonly Decision[]) => readonly BeingFixed[];
  read: () => readonly AgentHold[] | null;
  stamp: string;
}
