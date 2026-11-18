import { PersonRef } from "../records/fields";
import { type Check, type CheckGroup, checksNow, type OPTIONS } from "./checks";
import { answerDecision } from "./decisions";
import { recordFactCheckAnswer } from "./fact-checks";
import { recordCorrection } from "./memory-files";

// His answer to a check (`answer_check`, `bun life memory answer-check`): one call for every kind. Each option goes to
// the writer its kind already has, and the line written names the check it settled (the decision's id, the fact
// check's ref, the person, card or name, the matter's step), so nothing new is stored. A matter start's Start is the
// one act: host gives it (`CheckActs`), since only host reaches the desk.

export interface CheckAnswer {
  /** His words, verbatim. */
  note?: string;
  /** The option ids he picked: one for a guess of Life's; a decision takes several, or none with `note`. */
  options: string[];
  /** Who it is (`person:<id>`), for an option that names someone. */
  person?: string;
}

/** What host does for an answer that acts: Start asks the desk to start an agent on the check's matter (its `subject`, a step). */
export interface CheckActs {
  startAgent: (c: Check) => Promise<unknown>;
}

type Writer = (c: Check, a: CheckAnswer, acts: CheckActs) => Promise<unknown[]>;

/** The check's matter, as his word pins it: its step. */
const stepsOf = (c: Check) => [c.subject ?? ""];

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

/** What each option of Life's guesses writes, by group; typed by `OPTIONS`, so every option has its writer. */
const WRITERS: {
  [G in keyof typeof OPTIONS]: Record<
    (typeof OPTIONS)[G][number]["id"],
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
  "matter start": {
    dismiss: (c, a) =>
      correct(
        [{ answer: "dismiss", kind: "matter-start", steps: stepsOf(c) }],
        a
      ),
    "edit-goal": async (c, a) => {
      if (!a.note) {
        throw new Error("Not done: give his goal, in his words, as `note`.");
      }
      // His words are the goal itself, not a note on it; the check stays, with his goal, for Start or Dismiss.
      return [
        await recordCorrection({
          goal: a.note,
          kind: "matter-goal",
          steps: stepsOf(c),
        }),
      ];
    },
    // The desk refusing writes nothing: the check stays, to start again or dismiss.
    start: async (c, a, acts) => [
      await acts.startAgent(c),
      ...(await correct(
        [{ answer: "start", kind: "matter-start", steps: stepsOf(c) }],
        a
      )),
    ],
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
};

/** Records his answer to the open check `ref` through its kind's writer; returns the lines written. Throws when no open check has that ref or the option is not one of its own. */
export async function answerCheck(
  ref: string,
  a: CheckAnswer,
  acts: CheckActs
) {
  const check = (await checksNow()).find((c) => c.ref === ref);
  if (!check) {
    throw new Error(
      `Not done: no open check ${ref}; \`read_inbox\` lists them.`
    );
  }
  if (check.group === "decision") {
    return { done: [answerDecision(ref, a.options, a.note)], ref };
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
  const done = await write(check, a, acts);
  if (done.length === 0) {
    throw new Error(`Not done: ${ref} names no one to correct.`);
  }
  return { done, ref };
}
