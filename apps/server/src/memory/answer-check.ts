import { clock, daysBefore } from "../core/clock";
import { oneAtATime } from "../core/lock";
import type { CheckGroup } from "../core/names";
import { changeSetting, readMonthlyUsd } from "../core/settings";
import { PersonRef } from "../records/fields";
import {
  answerNamingQueue,
  readNamingQueueNow,
  readOwnerVoiceId,
  readVoiceNames,
} from "../sources/lifelog-voices";
import { HOME_LATER_FOR, isHomeLaterOf } from "./arrival-home";
import {
  atOrganizationRefOf,
  readAtOrganizationPairs,
} from "./at-organization";
import type { AddEventByHisWord, RunApifyByHisWord } from "./decision-add";
import {
  answerDecision,
  type EndByHisWord,
  type LookForDone,
} from "./decisions";
import { recordFactCheckAnswer } from "./fact-checks";
import { instructionsFor } from "./instructions";
import type { Check, LIFE_CHECKS } from "./life-checks";
import { isAwaitingHisWord, matterOfSteps, openStepsOf } from "./matter-read";
import { readMatterBook } from "./matters";
import { recordCorrection } from "./memory-files";
import { OWNER } from "./read-truth";
import { samePersonPairOf } from "./same-person";
import { type GuessedQueueItem, withVoiceGuesses } from "./voice-guesses";
import { type People, readPeople, voiceCardRefOf, voiceIdOf } from "./who";
import { dayNow, dayStart } from "./zones";

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

/** Adds a person of his directory to an organization of it with a role, by his Yes on an at organization card (host: `addOrganizationPersonByHisWord`); gives what was done. */
export type AddOrganizationPerson = (
  organization: string,
  person: string,
  role: string
) => Promise<string>;

/** Closes by his word the steps a your move card's Mark as done, or Drop, closes (`yourMoveClosingOf`, read by host before the plan with the option he picked: host's `endByHisWord`); gives the lines written. */
export type EndYourMove = () => Promise<unknown[]>;

/** What a writer is given besides the check and his answer: a voice's queue item with the people it was read with, the steps to report, the desk's start and a your move's end (his own token's `answer_check` only). */
interface WriterExtras {
  addDirectoryEntry?: AddDirectoryEntry;
  addOrganizationPerson?: AddOrganizationPerson;
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

/** His answer's refusal when the ask he saw is gone (answered, or changed since it was shown), in words his app shows as they are. */
export const NO_LONGER_OPEN =
  "Not done: this ask is no longer open; it was answered or changed since it was shown, so nothing was saved.";

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
    throw new Error(NO_LONGER_OPEN);
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
  voice: Voice | undefined,
  answerOf: (
    v: Voice
  ) =>
    | Parameters<typeof answerNamingQueue>[1]
    | Promise<Parameters<typeof answerNamingQueue>[1]>
) {
  if (!voice) {
    throw new Error(NO_LONGER_OPEN);
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
 * Who a voice's answer names: a new person by `name`, him by lifelog's owner id, else the lifelog id of Life's `person`
 * (`voiceIdOf`: the card's own, else the one id lifelog gives one of their names), else that person by their name.
 */
async function thisIs({ item, people }: Voice, c: Check, a: CheckAnswer) {
  if (a.name) {
    return { kind: "confirm", name: a.name } as const;
  }
  if (!a.person) {
    throw new Error(`Not done: give person or name for ${c.ref}.`);
  }
  const ref = personIn(a);
  // Him: lifelog knows him by its owner's id only, never by his directory name (which would make a second him).
  if (ref === OWNER) {
    const own = await readOwnerVoiceId();
    if (!own) {
      throw new Error("Not done: Voice has not heard you yet.");
    }
    return { kind: "assign", personId: own } as const;
  }
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

/** The pair an at organization card asks about, while Life still finds it as he saw it, its role too (its ref). */
async function atOrganizationNow(c: Pick<Check, "ref">) {
  const found = readAtOrganizationPairs(await readPeople()).find(
    (p) => atOrganizationRefOf(p) === c.ref
  );
  if (!found) {
    throw new Error(NO_LONGER_OPEN);
  }
  return found;
}

/** His Later, an answer every check takes (Later with no menu: his yes of 25 Nov 2026); a your move card's `not-now` is it too. */
export const LATER = "later";

/** The times of day a `later` instruction may name in words, as HH:MM. */
const TIMES_OF_DAY: readonly [RegExp, string][] = [
  [/\bmorning\b/i, "09:00"],
  [/\b(?:noon|lunch)\b/i, "12:00"],
  [/\bafternoon\b/i, "14:00"],
  [/\bevening\b/i, "18:00"],
  [/\b(?:tonight|night)\b/i, "20:00"],
];
const CLOCK_TIME = /\b(\d{1,2})(?::(\d\d))?\s*(am|pm)\b|\b(\d{1,2}):(\d\d)\b/i;

/** The time of day a `later` instruction's words name ("this evening", "at 7pm", "19:30"), as HH:MM; none when they name none. Pure. */
export function laterTimeOf(text: string) {
  const m = CLOCK_TIME.exec(text);
  if (m) {
    const h = Number(m[1] ?? m[4]) % 12;
    const hour = m[3]
      ? h + (m[3].toLowerCase() === "pm" ? 12 : 0)
      : Number(m[4]);
    const minute = m[2] ?? m[5] ?? "00";
    return hour < 24 ? `${String(hour).padStart(2, "0")}:${minute}` : undefined;
  }
  return TIMES_OF_DAY.find(([re]) => re.test(text))?.[1];
}

/** His newest `later` instruction in force on check `c`, its words. */
const laterInstructionOf = (c: Pick<Check, "matter">, now = clock()) =>
  instructionsFor({ matter: c.matter?.id }, now)
    .filter((i) => i.effect === "later")
    .at(-1)?.text;

/** Life's time for his Later before a deadline: 3 hours before it, never sooner than 30 minutes from now. */
const BEFORE_DEADLINE_MS = 3 * 3_600_000;
const SOONEST_MS = 30 * 60_000;

/**
 * Until when his Later holds check `c` from `now`: 24 hours when his newest `later` instruction on it names home
 * (`isHomeLaterOf`: his arrival home ends it sooner), else the next time of day it names (`laterTimeOf`), else tomorrow
 * 9:00 where he is; sooner before its deadline.
 */
export function laterOf(
  c: Pick<Check, "deadline" | "matter">,
  now = clock(),
  instruction = laterInstructionOf(c, now)
) {
  const today = dayNow(now);
  const time = instruction && laterTimeOf(instruction);
  const at = (day: string, hm: string) =>
    dayStart(day, undefined, hm).getTime();
  const nextAt = time
    ? [at(today, time), at(daysBefore(today, -1), time)].find(
        (t) => t > now.getTime()
      )
    : at(daysBefore(today, -1), "09:00");
  const next =
    instruction && isHomeLaterOf(instruction)
      ? now.getTime() + HOME_LATER_FOR
      : nextAt;
  const due = c.deadline
    ? Math.max(
        Date.parse(c.deadline) - BEFORE_DEADLINE_MS,
        now.getTime() + SOONEST_MS
      )
    : Number.POSITIVE_INFINITY;
  return new Date(
    Math.min(next ?? now.getTime() + SOONEST_MS, due)
  ).toISOString();
}

/** The first instant of next month where he is: a fix ask he kept is asked again then, if still due. */
const monthEndOf = (now = clock()) => {
  const [y = 0, m = 0] = dayNow(now).split("-").map(Number);
  const next =
    m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return dayStart(next).toISOString();
};

/** His Later on check `c`: one `deferred` correction by its ref, until Life's time (`laterOf`). */
const deferOf = (c: Check, a: CheckAnswer) => {
  const instruction = laterInstructionOf(c);
  return correct(
    [
      {
        kind: "deferred",
        ref: c.ref,
        until: laterOf(c, clock(), instruction),
        ...(instruction && isHomeLaterOf(instruction) ? { home: true } : {}),
      },
    ],
    a
  );
};

/** The open matter a your move card is on, as it reads now: the one it named (`matter`), else the one holding its step. */
async function yourMoveMatterOf(c: Pick<Check, "matter" | "ref" | "subject">) {
  const open = (await readMatterBook(await readPeople(), dayNow())).filter(
    isAwaitingHisWord
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
    | (G extends "voice" ? "not-anyone-i-know" : never),
    Writer
  >;
} = {
  // Bound to the pair he saw, while Life still finds it (`readAtOrganizationPairs`): Yes adds the link to his directory
  // (his own token's answer_check only), No is his `not-at-organization`, so the pair is never asked again.
  "at organization": {
    "not-at-organization": async (c, a) => {
      const { organization, person } = await atOrganizationNow(c);
      return correct(
        [{ kind: "not-at-organization", organization, person }],
        a
      );
    },
    yes: async (c, _a, x) => {
      if (!x.addOrganizationPerson) {
        throw new Error(
          "Not done: Yes comes only through his own answer_check."
        );
      }
      const { organization, person, role } = await atOrganizationNow(c);
      return [await x.addOrganizationPerson(organization, person, role)];
    },
  },
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
  // A fix ask: Raise doubles the monthly amount (his `change_setting`); Keep holds it until the month's end; Later, Life's
  // time; Sign in is his app's sheet (`sign_in_to_network`), never an answer.
  fix: {
    keep: (c, a) =>
      correct([{ kind: "deferred", ref: c.ref, until: monthEndOf() }], a),
    later: deferOf,
    raise: () => {
      const monthly = readMonthlyUsd();
      if (monthly === undefined) {
        throw new Error("Not done: no monthly amount is set.");
      }
      changeSetting({ monthlyUsd: monthly * 2 });
      return Promise.resolve([]);
    },
    "sign-in": () => {
      throw new Error(
        "Not done: sign in from the sheet this card opens in Life's app."
      );
    },
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
  // Bound to the pair he saw (`samePersonRefOf`): "Same person" folds the guess into the other; "Different"
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
      return answerVoice(voice, (i) =>
        thisIs(i, c, { ...a, person: c.subject ?? undefined })
      );
    },
    media: (_c, _a, { voice }) =>
      answerVoice(voice, async () => ({ kind: "media" })),
    "not-anyone-i-know": (_c, _a, { voice }) =>
      answerVoice(voice, async () => ({ kind: "ignore" })),
    "not-relevant": (_c, _a, { voice }) =>
      answerVoice(voice, async () => ({ kind: "not_relevant" })),
    "this-is": (c, a, { voice }) => answerVoice(voice, (v) => thisIs(v, c, a)),
  },
  // Done, Drop and Hand over act through host (`endYourMove`, `startAgent`), only as the card offers them now.
  "your move": {
    done: (_c, _a, x) => endYourMoveOf(x),
    drop: (_c, _a, x) => endYourMoveOf(x),
    "not-now": deferOf,
    start: async (c, a, x) => {
      if (!(x.startAgent && c.options.some((o) => o.id === "start"))) {
        throw new Error(
          "Not done: Hand over comes only through his own answer_check, while the card offers it."
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
 * person or organization he names, `partyNamed`) and `addOrganizationPerson` (an at organization card's Yes) are given only for his own token's `answer_check`. Throws when the
 * option is not one of its own.
 */
export async function answerCheck(
  check: Check,
  a: CheckAnswer,
  via: "connector" | "session",
  {
    addDirectoryEntry,
    addOrganizationPerson,
    add,
    answerKey,
    end,
    endYourMove,
    look,
    onStep,
    run,
    startAgent,
  }: Omit<WriterExtras, "voice"> & {
    add?: AddEventByHisWord;
    answerKey?: string;
    end?: EndByHisWord;
    look?: LookForDone;
    run?: RunApifyByHisWord;
  } = {}
) {
  const { ref } = check;
  if (a.options.length === 1 && a.options[0] === LATER) {
    const done = await deferOf(check, a);
    onStep?.("recorded");
    return {
      answer: a,
      check,
      done,
      item: undefined,
      recordedAs: undefined,
      ref,
    };
  }
  if (check.group === "decision") {
    return {
      answer: a,
      check,
      done: await answerDecision(ref, a.options, a.note, {
        add,
        answerKey,
        end,
        look,
        onStep,
        run,
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
      addOrganizationPerson,
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
