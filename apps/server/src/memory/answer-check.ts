import { PersonRef } from "../records/fields";
import {
  answerNamingQueue,
  type NamingQueueItem,
  namingQueueGuessesOf,
  readNamingQueue,
} from "../sources/lifelog-voices";
import type { Check, CheckGroup, LIFE_CHECKS } from "./checks";
import { answerDecision } from "./decisions";
import { recordFactCheckAnswer } from "./fact-checks";
import { matterOfSteps } from "./matter-read";
import { readMatterBook } from "./matters";
import { recordCorrection } from "./memory-files";
import { readPeople, voicePersonOf } from "./who";
import { dayNow } from "./zones";

// His answer to a check (`answer_check`, `bun life memory answer-check`): one call for every kind. Each option goes to
// the writer its kind already has, and the line written names the check it settled (the decision's id, the fact
// check's ref, the person, card or name, the matter's steps). A new matter's Start is the one answer that acts: host
// hands it in (`startAgent`), since only host reaches the desk.

export interface CheckAnswer {
  /** A voice's new person: their name. */
  name?: string;
  /** His words, verbatim. */
  note?: string;
  /** The option ids he picked: one for a guess of Life's; a decision takes several, or none with `note`. */
  options: string[];
  /** Who it is (`person:<id>`), for an option that names someone. */
  person?: string;
}

/** Asks the desk to start an agent on the new matter `c`, its goal as the brief (host: `changeRegisteredAgent`); gives the ask's ledger line id. */
export type StartAgent = (c: Check, goal: string) => Promise<{ ask: string }>;

/** What a writer is given besides the check and his answer: a voice's queue item, the steps to report, the desk's start (his app's tap only). */
interface WriterExtras {
  item?: NamingQueueItem;
  onStep?: (step: string, detail?: Record<string, unknown>) => void;
  startAgent?: StartAgent;
}

type Writer = (c: Check, a: CheckAnswer, x: WriterExtras) => Promise<unknown[]>;

/** `person`, checked: the options that name someone need it. */
function personIn(a: CheckAnswer) {
  const ref = PersonRef.safeParse(a.person);
  if (!ref.success) {
    throw new Error("Not done: give who it is as `person` (person:<id>).");
  }
  return ref.data;
}

const correct = (said: object[], a: CheckAnswer) =>
  Promise.all(
    said.map((s) =>
      recordCorrection({ ...s, ...(a.note ? { note: a.note } : {}) })
    )
  );

/** The voice lifelog still asks him to name for the open check `c`. */
async function readVoiceItem(c: Pick<Check, "ref">) {
  const item = (await readNamingQueue()).find((i) => `voice:${i.id}` === c.ref);
  if (!item) {
    throw new Error(`Not done: no open check ${c.ref}`);
  }
  return item;
}

/** His answer on a voice, sent to lifelog for every turn of it; nothing is written in memory. */
async function answerVoice(
  c: Check,
  item: NamingQueueItem | undefined,
  answerOf: (
    item: NamingQueueItem
  ) => Promise<Parameters<typeof answerNamingQueue>[1]>
) {
  if (!item) {
    throw new Error(`Not done: no open check ${c.ref}`);
  }
  return [
    await answerNamingQueue(
      item.voices.map(({ jobId, speakerLabel }) => ({ jobId, speakerLabel })),
      await answerOf(item)
    ),
  ];
}

/** Who a voice's answer names: a new person by `name`, else the lifelog person that is Life's `person`, else that person by their name. */
async function thisIs(item: NamingQueueItem, c: Check, a: CheckAnswer) {
  if (a.name) {
    return { kind: "confirm", name: a.name } as const;
  }
  if (!a.person) {
    throw new Error(`Not done: give person or name for ${c.ref}.`);
  }
  const ref = personIn(a);
  const people = await readPeople();
  const id = namingQueueGuessesOf(item).find(
    (x) => x && voicePersonOf(people.resolve, x, null) === ref
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

/** What each option of Life's guesses writes, by group; typed by `LIFE_CHECKS`, so every option has its writer. */
const WRITERS: {
  [G in keyof typeof LIFE_CHECKS]: Record<
    (typeof LIFE_CHECKS)[G]["options"][number]["id"],
    Writer
  >;
} = {
  card: {
    "same-person": (c, a) =>
      correct([{ from: c.ref, kind: "same-person", to: personIn(a) }], a),
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
    "same-person": (c, a) =>
      correct([{ from: c.ref, kind: "same-person", to: personIn(a) }], a),
    "this-is": (c, a) =>
      correct(
        c.about
          .slice(0, 1)
          .map((n) => ({ kind: "this-is", nameOrHandle: n, person: c.ref })),
        a
      ),
  },
  name: {
    "this-is": (c, a) => {
      const person = personIn(a);
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
    // The goal he saw becomes his word (the phone's start does the same), then the desk is asked with it as the brief.
    start: async (c, _a, x) => {
      if (!x.startAgent) {
        throw new Error("Not done: Start is his tap in his app.");
      }
      const { goal, steps } = await newMatterOf(c);
      const saved =
        goal.by === "owner"
          ? []
          : [
              await recordCorrection({
                goal: goal.text,
                kind: "matter-direction",
                steps,
              }),
            ];
      x.onStep?.("goal_saved");
      return [...saved, await x.startAgent(c, goal.text)];
    },
  },
  voice: {
    media: (c, _a, { item }) =>
      answerVoice(c, item, async () => ({ kind: "media" })),
    "not-anyone-i-know": (c, _a, { item }) =>
      answerVoice(c, item, async () => ({ kind: "ignore" })),
    "not-relevant": (c, _a, { item }) =>
      answerVoice(c, item, async () => ({ kind: "not_relevant" })),
    "this-is": (c, a, { item }) => answerVoice(c, item, (i) => thisIs(i, c, a)),
  },
};

/**
 * Records his answer to the open check `check` (host finds it: `openCheckOf`) through its kind's writer (a decision's
 * draft is sent only `via` his app); returns the check, the lines written and, for a voice, its queue item. `onStep`
 * hears `recorded` once they are, and a send's or a start's own steps; `answerKey` is his app's key for this tap, kept on a
 * decision's answer; `startAgent` is a new matter's Start, given only for his app's tap (`answer_check`). Throws when the
 * option is not one of its own.
 */
export async function answerCheck(
  check: Check,
  a: CheckAnswer,
  via: "connector" | "session",
  {
    answerKey,
    onStep,
    startAgent,
  }: Omit<WriterExtras, "item"> & { answerKey?: string } = {}
) {
  const { ref } = check;
  if (check.group === "decision") {
    return {
      check,
      done: await answerDecision(ref, a.options, a.note, {
        answerKey,
        onStep,
        via,
      }),
      item: undefined,
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
  const item = check.group === "voice" ? await readVoiceItem(check) : undefined;
  const done = await write(check, a, { item, onStep, startAgent });
  if (done.length === 0) {
    throw new Error(`Not done: ${ref} names no one to correct.`);
  }
  onStep?.("recorded");
  return { check, done, item, ref };
}
