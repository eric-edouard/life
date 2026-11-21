import { daysBefore } from "../core/clock";
import { oneAtATime } from "../core/lock";
import type { CheckGroup } from "../core/names";
import { PersonRef } from "../records/fields";
import {
  answerNamingQueue,
  readNamingQueueNow,
  readVoiceNames,
} from "../sources/lifelog-voices";
import {
  answerDecision,
  type EndByHisWord,
  type LookForDone,
} from "./decisions";
import { recordFactCheckAnswer } from "./fact-checks";
import type { Check, LIFE_CHECKS } from "./life-checks";
import { matterOfSteps, openStepsOf } from "./matter-read";
import { readMatterBook } from "./matters";
import { recordCorrection } from "./memory-files";
import { samePersonPairOf } from "./same-person";
import { type GuessedQueueItem, withVoiceGuesses } from "./voice-guesses";
import { type People, readPeople, voiceCardRefOf, voiceIdOf } from "./who";
import { dayNow } from "./zones";

// His answer to a check (`answer_check`, `bun life memory answer-check`): one call for every kind. Each option goes to
// the writer its kind already has, and the line written names the check it settled (the decision's id, the fact
// check's ref, the person, card or name, the matter's steps). A new matter's Start and a decision's `ends` option are
// the answers that act through host: it hands them in (`startAgent`, `end`, `addDirectoryEntry`), since only host reaches the
// desk, the to-do list and his directory.

export interface CheckAnswer {
  /** A new person's name: a voice's, or someone he adds to his directory (`namedIn`); an organization's, his name for it. */
  name?: string;
  /** His words, verbatim; on a new matter's Start, the goal he saw. */
  note?: string;
  /** The option ids he picked: one for a guess of Life's; a decision takes several, or none with `note`. */
  options: string[];
  /** Who it is (`person:<id>`, or a name Life knows), for an option that names someone. */
  person?: string;
}

/** Asks the desk to start an agent on the new matter `c` with the goal he saw, saved as his goal and its brief (host: `changeRegisteredAgent`); gives the ask's ledger line id. */
export type StartAgent = (c: Check, goal: string) => Promise<{ ask: string }>;

/** Adds a person or an organization to his directory by the name he gave answering a check, with what it is to him (host: `addDirectoryEntryByHisWord`); gives its ref. */
export type AddDirectoryEntry = (
  kind: "person" | "organization",
  name: string,
  fields?: { relation?: string }
) => Promise<string>;

/** Closes by his word the steps a your move card's Mark as done, or Drop, closes (`yourMoveClosingOf`, read by host before the plan with the option he picked: host's `endByHisWord`); gives the lines written. */
export type EndYourMove = () => Promise<unknown[]>;

/** What a writer is given besides the check and his answer: a voice's queue item with the people it was read with, the steps to report, the desk's start and a your move's end (his own token's `answer_check` only). */
interface WriterExtras {
  addDirectoryEntry?: AddDirectoryEntry;
  endYourMove?: EndYourMove;
  onStep?: (step: string, detail?: Record<string, unknown>) => void;
  startAgent?: StartAgent;
  voice?: Voice;
}

type Writer = (c: Check, a: CheckAnswer, x: WriterExtras) => Promise<unknown[]>;

/** `person`, checked: the options that name someone need it (`person:<id>`; a typed name is read first, `typedPersonOf`). */
function personIn(a: CheckAnswer) {
  const ref = PersonRef.safeParse(a.person);
  if (!ref.success) {
    throw new Error(
      "Not done: give who it is as `person` (person:<id>, or a name Life knows)."
    );
  }
  return ref.data;
}

/**
 * A name his app typed as `person`, read as the one person it names, so his answer is never written against a guess: only
 * by his own word, his truth/ or his Contacts, and only a name no two of them share. Gives the answer with that person's
 * ref and their name, to show what was recorded; a `person:<id>`, or no person, passes as it is.
 */
async function typedPersonOf(a: CheckAnswer, read?: People) {
  if (!a.person || PersonRef.safeParse(a.person).success) {
    return { a, recordedAs: undefined };
  }
  const people = read ?? (await readPeople());
  const r = people.readingNow(a.person);
  if (!r || r.by === "guess" || (r.isShared && r.by !== "his word")) {
    throw new Error(
      `Not done: Life doesn't know who "${a.person}" is for sure; pick from the card or use their full name.`
    );
  }
  return { a: { ...a, person: r.ref }, recordedAs: people.nameOf(r.ref) };
}

/** Who an answer that takes "person or name" names: its `person`, else his new person's `name` (`partyNamed`), his `note` as who they are. */
const namedIn = (a: CheckAnswer, x: WriterExtras) =>
  a.name ? partyNamed(a.name, "person", x, a.note) : personIn(a);

/**
 * The one party of `kind` his word, truth/ or Contacts already holds by `name`, else a new `kind` added to his directory
 * with what it is to him (`addDirectoryEntry`, his own token's answer only). A party of the other kind by that name is
 * refused, never reused nor doubled.
 */
async function partyNamed(
  name: string,
  kind: "person" | "organization",
  x: WriterExtras,
  relation?: string
) {
  const people = await readPeople();
  const r = people.readingNow(name);
  if (r && r.by !== "guess" && !r.isShared) {
    if (people.isOrganization(r.ref) !== (kind === "organization")) {
      throw new Error(
        `Not done: "${name}" is already ${kind === "organization" ? "a person" : "an organization"} he knows.`
      );
    }
    return r.ref;
  }
  if (!x.addDirectoryEntry) {
    throw new Error(
      `Not done: Life knows no one called "${name}"; add them to his directory first.`
    );
  }
  return x.addDirectoryEntry(kind, name, relation ? { relation } : {});
}

const correct = (said: object[], a: CheckAnswer) =>
  Promise.all(
    said.map((s) =>
      recordCorrection({ ...s, ...(a.note ? { note: a.note } : {}) })
    )
  );

/** A voice's queue item, as lifelog gives it now, and the people it was read with. */
interface Voice {
  item: GuessedQueueItem;
  people: People;
}

/**
 * The voice lifelog still asks him to name for the open check `c`, as lifelog gives it now (never a kept list), and
 * only while it is the card he saw: one he can be asked about, suggesting the same person (its ref, `voiceCardRefOf`).
 */
async function readVoice(c: Pick<Check, "ref">): Promise<Voice> {
  const people = await readPeople();
  const queue = await withVoiceGuesses(await readNamingQueueNow()).catch(
    (e: Error) => {
      throw new Error(
        `Not done: the voice guesses behind ${c.ref} cannot be read now (${e.message}).`
      );
    }
  );
  const item = queue.find(
    (i) => i.kind !== "several" && voiceCardRefOf(people, i) === c.ref
  );
  if (!item) {
    throw new Error(
      `Not done: no open check ${c.ref} (lifelog may have changed it since it was shown; read the inbox again).`
    );
  }
  return { item, people };
}

/**
 * One voice answer at a time in this process (the phone releases held answers at once): its read of lifelog's queue
 * and its answer share a turn. ponytail: a turn waits for the ones before it, each a queue read (34 to 120 ms measured)
 * and one write; a hung lifelog holds the rest up to its read limit, past the phone's 15 s idle wait (the answer still
 * lands, the phone shows it failed). Answers from the CLI's own process are not in this chain.
 */
const voiceTurn = oneAtATime();

/** His answer on a voice, sent to lifelog for every turn of it; nothing is written in memory. */
async function answerVoice(
  c: Check,
  voice: Voice | undefined,
  answerOf: (
    v: Voice
  ) =>
    | Parameters<typeof answerNamingQueue>[1]
    | Promise<Parameters<typeof answerNamingQueue>[1]>
) {
  if (!voice) {
    throw new Error(`Not done: no open check ${c.ref}`);
  }
  return [
    await answerNamingQueue(
      voice.item.voices.map(({ jobId, speakerLabel }) => ({
        jobId,
        speakerLabel,
      })),
      await answerOf(voice)
    ),
  ];
}

/**
 * Who a voice's answer names: a new person by `name`, else the lifelog id of Life's `person` (`voiceIdOf`: the card's
 * own, else the one id lifelog gives one of their names), else that person by their name.
 */
async function thisIs({ item, people }: Voice, c: Check, a: CheckAnswer) {
  if (a.name) {
    return { kind: "confirm", name: a.name } as const;
  }
  if (!a.person) {
    throw new Error(`Not done: give person or name for ${c.ref}.`);
  }
  const ref = personIn(a);
  const aliases =
    people.truth.people.find((p) => `person:${p.id}` === ref)?.aliases ?? [];
  const id =
    voiceIdOf(people, item, ref) ??
    voiceIdOf(
      people,
      item,
      ref,
      await readVoiceNames([], [people.nameOf(ref), ...aliases])
    );
  return id
    ? ({ kind: "assign", personId: id } as const)
    : ({ kind: "confirm", name: people.nameOf(ref) } as const);
}

/** The new matter a check offers, as it reads now: its steps (what his word is pinned to) and its goal. */
async function newMatterOf(c: Pick<Check, "ref">) {
  const v = matterOfSteps(await readMatterBook(await readPeople(), dayNow()), [
    c.ref,
  ]);
  if (!v?.goal) {
    throw new Error(`Not done: no matter ${c.ref} with a goal.`);
  }
  return { goal: v.goal, steps: v.steps.map((s) => s.ref) };
}

/** How long his "Not now" hides a your move card: it is back on the third day after. */
export const NOT_NOW_DAYS = 3;

/** The open matter a your move card is on, as it reads now: the one it named (`matter`), else the one holding its step. */
async function yourMoveMatterOf(c: Pick<Check, "matter" | "ref" | "subject">) {
  const open = (await readMatterBook(await readPeople(), dayNow())).filter(
    (m) => m.open
  );
  const v =
    open.find((m) => m.id === c.matter?.id) ??
    matterOfSteps(open, [c.subject ?? ""], c.matter?.id);
  if (!v) {
    throw new Error(`Not done: no open matter holds ${c.ref} now.`);
  }
  return v;
}

/** What a your move card's Mark as done, or Drop, closes: its step, while it is still open on its matter (`openStepsOf`). */
export async function yourMoveClosingOf(
  c: Pick<Check, "matter" | "ref" | "subject">
) {
  const closing = openStepsOf(await yourMoveMatterOf(c), c.subject ?? "");
  if (closing.length === 0) {
    throw new Error(`Not done: ${c.subject} is no longer open.`);
  }
  return closing;
}

/** Mark as done or Drop on a your move card: only through his own answer_check, which gives `endYourMove`. */
function endYourMoveOf(x: WriterExtras) {
  if (!x.endYourMove) {
    throw new Error(
      "Not done: Mark as done and Drop come only through his own answer_check."
    );
  }
  return x.endYourMove();
}

/** What each option of Life's guesses writes, by group; typed by `LIFE_CHECKS`, so every option has its writer. */
const WRITERS: {
  [G in keyof typeof LIFE_CHECKS]: Record<
    | (typeof LIFE_CHECKS)[G]["options"][number]["id"]
    // Still accepted from installed builds, no longer offered.
    | (G extends "voice" ? "media" | "not-anyone-i-know" : never),
    Writer
  >;
} = {
  "contacts card": {
    "same-person": async (c, a, x) =>
      correct(
        [{ from: c.ref, kind: "same-person", to: await namedIn(a, x) }],
        a
      ),
  },
  ending: {
    false: async (c, a) => [
      await recordFactCheckAnswer(c.ref, "false", a.note),
    ],
    outdated: async (c, a) => [
      await recordFactCheckAnswer(c.ref, "outdated", a.note),
    ],
  },
  "guessed person": {
    // One name or handle is enough: his `this-is` to the guess is what confirms it (`guessTestOf`).
    "not-this-person": (c, a) =>
      correct(
        c.about.map((n) => ({
          kind: "not-this-person",
          nameOrHandle: n,
          person: c.ref,
        })),
        a
      ),
    "same-person": async (c, a, x) =>
      correct(
        [{ from: c.ref, kind: "same-person", to: await namedIn(a, x) }],
        a
      ),
    "this-is": (c, a) =>
      correct(
        c.about
          .slice(0, 1)
          .map((n) => ({ kind: "this-is", nameOrHandle: n, person: c.ref })),
        a
      ),
  },
  name: {
    "not-relevant": (c, a) =>
      correct(
        c.about.map((n) => ({ kind: "not-worth-naming", nameOrHandle: n })),
        a
      ),
    // His name for it (default the card's first name) and his words as what it is to him; each name of the card is it.
    organization: async (c, a, x) => {
      const party = await partyNamed(
        a.name ?? c.about[0] ?? "",
        "organization",
        x,
        a.note
      );
      return correct(
        c.about.map((n) => ({
          kind: "this-is",
          nameOrHandle: n,
          person: party,
        })),
        a
      );
    },
    "this-is": async (c, a, x) => {
      const person = await namedIn(a, x);
      return correct(
        c.about.map((n) => ({ kind: "this-is", nameOrHandle: n, person })),
        a
      );
    },
  },
  "new matter": {
    dismiss: async (c, a) =>
      correct(
        [
          {
            kind: "new-matter-dismissed",
            steps: (await newMatterOf(c)).steps,
          },
        ],
        a
      ),
    "edit-goal": async (c, a) => {
      if (!a.note) {
        throw new Error("Not done: give the goal, in his words, as `note`.");
      }
      // His words are the goal itself, not a note on it; the check stays, with his goal, for Start or Dismiss.
      const { steps } = await newMatterOf(c);
      return [
        await recordCorrection({
          goal: a.note,
          kind: "matter-direction",
          steps,
        }),
      ];
    },
    // The goal he saw (his app sends it as `note`; else the goal as it reads now) is the start's words: the desk's start saves it as his goal.
    start: async (c, a, x) => {
      if (!x.startAgent) {
        throw new Error(
          "Not done: Start comes only through his own answer_check."
        );
      }
      return [
        await x.startAgent(c, a.note ?? (await newMatterOf(c)).goal.text),
      ];
    },
  },
  // Bound to the pair he saw (`samePersonRefOf`): "Same person" folds the guess into the other; "Different people"
  // says each of the guess's handles is not them, so the pair is never asked again.
  "same person": {
    "not-this-person": (c, a) =>
      correct(
        c.about.map((n) => ({
          kind: "not-this-person",
          nameOrHandle: n,
          person: samePersonPairOf(c.ref).other,
        })),
        a
      ),
    "same-person": (c, a) => {
      const { guess, other } = samePersonPairOf(c.ref);
      return correct([{ from: guess, kind: "same-person", to: other }], a);
    },
  },
  voice: {
    // "Yes" to the guess in use: the person lifelog suggests (the check's `subject`).
    "is-them": (c, a, { voice }) => {
      if (a.name || (a.person && a.person !== c.subject)) {
        throw new Error(
          `Not done: "Yes" names the person on ${c.ref}; another person or a name goes with "Someone else…".`
        );
      }
      return answerVoice(c, voice, (i) =>
        thisIs(i, c, { ...a, person: c.subject ?? undefined })
      );
    },
    media: (c, _a, { voice }) =>
      answerVoice(c, voice, async () => ({ kind: "media" })),
    "not-anyone-i-know": (c, _a, { voice }) =>
      answerVoice(c, voice, async () => ({ kind: "ignore" })),
    "not-relevant": (c, _a, { voice }) =>
      answerVoice(c, voice, async () => ({ kind: "not_relevant" })),
    "this-is": (c, a, { voice }) =>
      answerVoice(c, voice, (v) => thisIs(v, c, a)),
  },
  // Done, Drop and Hand to an agent act through host (`endYourMove`, `startAgent`), only as the card offers them now.
  "your move": {
    done: (_c, _a, x) => endYourMoveOf(x),
    drop: (_c, _a, x) => endYourMoveOf(x),
    "not-now": async (c, a) => {
      const v = await yourMoveMatterOf(c);
      return correct(
        [
          {
            kind: "your-move-not-now",
            matter: v.id,
            steps: v.steps.map((s) => s.ref),
            until: daysBefore(dayNow(), -NOT_NOW_DAYS),
          },
        ],
        a
      );
    },
    start: async (c, a, x) => {
      if (!(x.startAgent && c.options.some((o) => o.id === "start"))) {
        throw new Error(
          "Not done: Hand to an agent comes only through his own answer_check, while the card offers it."
        );
      }
      return [await x.startAgent(c, a.note ?? c.goal ?? c.title)];
    },
  },
};

/**
 * Records his answer to the open check `check` (host finds it: `openCheckOf`) through its kind's writer (a decision's
 * draft is sent only `via` his app); returns the check, the lines written and, for a voice, its queue item. `onStep`
 * hears `recorded` once they are, and a send's or a start's own steps; `answerKey` is his app's key for this tap, kept on a
 * decision's answer; `startAgent` (a new matter's Start), `end` (a decision's `ends` option), `look` (its `looks` option) and `addDirectoryEntry` (a new
 * person or organization he names, `partyNamed`) are given only for his own token's `answer_check`. Throws when the
 * option is not one of its own.
 */
export async function answerCheck(
  check: Check,
  a: CheckAnswer,
  via: "connector" | "session",
  {
    addDirectoryEntry,
    answerKey,
    end,
    endYourMove,
    look,
    onStep,
    startAgent,
  }: Omit<WriterExtras, "voice"> & {
    answerKey?: string;
    end?: EndByHisWord;
    look?: LookForDone;
  } = {}
) {
  const { ref } = check;
  if (check.group === "decision") {
    return {
      answer: a,
      check,
      done: await answerDecision(ref, a.options, a.note, {
        answerKey,
        end,
        look,
        onStep,
        via,
      }),
      item: undefined,
      recordedAs: undefined,
      ref,
    };
  }
  const writers: Partial<Record<string, Writer>> =
    WRITERS[check.group as Exclude<CheckGroup, "decision">];
  const [option = "", ...more] = a.options;
  const write = Object.hasOwn(writers, option) ? writers[option] : undefined;
  if (!write || more.length > 0) {
    throw new Error(
      `Not done: pick one of ${Object.keys(writers).join(", ")} for ${ref}.`
    );
  }
  const answer = async (read?: Voice) => {
    const typed = await typedPersonOf(a, read?.people);
    const done = await write(check, typed.a, {
      addDirectoryEntry,
      endYourMove,
      onStep,
      startAgent,
      voice: read,
    });
    return { done, typed, voice: read };
  };
  // A voice is read and answered in its turn: each reads lifelog's queue after the answer before it landed.
  const { done, typed, voice } = await (check.group === "voice"
    ? voiceTurn(async () => answer(await readVoice(check)))
    : answer());
  if (done.length === 0) {
    throw new Error(`Not done: ${ref} names no one to correct.`);
  }
  onStep?.("recorded");
  return {
    answer: typed.a,
    check,
    done,
    item: voice?.item,
    recordedAs: typed.recordedAs ?? a.name,
    ref,
  };
}
