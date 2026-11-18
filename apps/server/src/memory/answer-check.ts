import { PersonRef } from "../records/fields";
import {
  answerNamingQueue,
  type NamingQueueItem,
  namingQueueGuessesOf,
  readNamingQueue,
} from "../sources/lifelog-voices";
import {
  type Check,
  type CheckGroup,
  checksNow,
  type LIFE_CHECKS,
} from "./checks";
import { answerDecision } from "./decisions";
import { recordFactCheckAnswer } from "./fact-checks";
import { recordCorrection } from "./memory-files";
import { readPeople, voicePersonOf } from "./who";

// His answer to a check (`answer_check`, `bun life memory answer-check`): one call for every kind. Each option goes to
// the writer its kind already has, and the line written names the check it settled (the decision's id, the fact
// check's ref, the person, card or name), so nothing new is stored.

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

type Writer = (
  c: Check,
  a: CheckAnswer,
  item?: NamingQueueItem
) => Promise<unknown[]>;

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
  voice: {
    media: (c, _a, item) =>
      answerVoice(c, item, async () => ({ kind: "media" })),
    "not-anyone-i-know": (c, _a, item) =>
      answerVoice(c, item, async () => ({ kind: "ignore" })),
    "not-relevant": (c, _a, item) =>
      answerVoice(c, item, async () => ({ kind: "not_relevant" })),
    "this-is": (c, a, item) => answerVoice(c, item, (i) => thisIs(i, c, a)),
  },
};

/**
 * Records his answer to the open check `ref` through its kind's writer (a decision's draft is sent only `via` his app);
 * returns the check it found, the lines written and, for a voice, its queue item. `onStep` hears `recorded` once they are, and a send's own steps; `answerKey`
 * is his app's key for this tap, kept on a decision's answer. Throws when no open check has that ref or the option is
 * not one of its own.
 */
export async function answerCheck(
  ref: string,
  a: CheckAnswer,
  via: "connector" | "session" = "session",
  {
    answerKey,
    onStep,
  }: {
    answerKey?: string;
    onStep?: (step: string, detail?: Record<string, unknown>) => void;
  } = {}
) {
  const check = (await checksNow()).find((c) => c.ref === ref);
  if (!check) {
    throw new Error(
      `Not done: no open check ${ref}; \`read_inbox\` lists them.`
    );
  }
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
  const done = await write(check, a, item);
  if (done.length === 0) {
    throw new Error(`Not done: ${ref} names no one to correct.`);
  }
  onStep?.("recorded");
  return { check, done, item, ref };
}
