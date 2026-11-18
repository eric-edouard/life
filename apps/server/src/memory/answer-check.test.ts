import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import type { NamingQueueItem } from "../sources/lifelog-voices";
import { answerCheck as answerWith, type CheckAnswer } from "./answer-check";
import type { Check, CheckGroup, InboxCheck } from "./checks";
import { DECISIONS, decisionsNow, requestDecision } from "./decisions";
import { CORRECTIONS, readCorrections } from "./memory-files";

const check = (ref: string, group: CheckGroup, about: string[] = []) =>
  ({ about, group, kind: group, ref }) as unknown as InboxCheck;
const guess = check("person:inf_kit", "guessed person", [
  "Kit",
  "+33600000001",
]);
const name = check("name:kit", "name", ["Kit", "kit"]);
const card = check("person:con_kit", "card");
const ending = check("obs_000000000001", "ending");
/** The goals a new matter's Start asked the desk to start on. */
let started: string[] = [];
const answerCheck = (c: Check, a: CheckAnswer) =>
  answerWith(c, a, "session", {
    startAgent: (_c, goal) => {
      started.push(goal);
      return Promise.resolve({ ask: "entry_000000000001" });
    },
  });

beforeEach(() => {
  rmSync(CORRECTIONS, { force: true });
  started = [];
});
afterEach(() => rmSync(CORRECTIONS, { force: true }));

const said = () =>
  readCorrections().map(({ at: _at, schemaVersion: _v, ...c }) => c);

test("a guessed person: yes confirms it by one name, no refuses each of its names, someone else folds it into them", async () => {
  await answerCheck(guess, { note: "my plumber", options: ["this-is"] });
  await answerCheck(guess, { options: ["not-this-person"] });
  await expect(
    answerCheck(guess, { options: ["same-person"] })
  ).rejects.toThrow("`person`");
  await answerCheck(guess, {
    options: ["same-person"],
    person: "person:kit",
  });
  expect(said()).toEqual([
    {
      kind: "this-is",
      nameOrHandle: "Kit",
      note: "my plumber",
      person: guess.ref,
    },
    { kind: "not-this-person", nameOrHandle: "Kit", person: guess.ref },
    {
      kind: "not-this-person",
      nameOrHandle: "+33600000001",
      person: guess.ref,
    },
    { from: guess.ref, kind: "same-person", to: "person:kit" },
  ]);
});

test("a name reads as the person he names, each way it was written; a card becomes theirs", async () => {
  await answerCheck(name, { options: ["this-is"], person: "person:kit" });
  await answerCheck(card, {
    options: ["same-person"],
    person: "person:kit",
  });
  expect(said()).toEqual([
    { kind: "this-is", nameOrHandle: "Kit", person: "person:kit" },
    { kind: "this-is", nameOrHandle: "kit", person: "person:kit" },
    { from: card.ref, kind: "same-person", to: "person:kit" },
  ]);
});

test("an ending goes to its fact-check answer", async () => {
  const record = spyOn(
    await import("./fact-checks"),
    "recordFactCheckAnswer"
  ).mockResolvedValue({} as never);
  try {
    await answerCheck(ending, { note: "paid", options: ["outdated"] });
    expect(record).toHaveBeenCalledWith(ending.ref, "outdated", "paid");
  } finally {
    record.mockRestore();
  }
});

test("one option of the check's own; an unknown option or a second option is refused, writing nothing", async () => {
  await Promise.all(
    (
      [
        [ending, ["this-is"]],
        [ending, ["constructor"]],
        [ending, []],
        [guess, ["this-is", "not-this-person"]],
      ] as const
    ).map(([c, options]) =>
      expect(answerCheck(c, { options: [...options] })).rejects.toThrow(
        "Not done"
      )
    )
  );
  expect(said()).toEqual([]);
});

test("a decision goes to answerDecision", async () => {
  rmSync(DECISIONS, { force: true });
  const { id } = await requestDecision("planner", {
    deadline: new Date(Date.now() + DAY).toISOString(),
    options: [
      { id: "yes", label: "Book Kit" },
      { id: "wait", label: "Wait" },
    ],
    question: "Book Kit?",
    title: "Cheapest.",
  });
  await answerCheck(check(id, "decision"), { options: ["yes"] });
  expect(decisionsNow().find((d) => d.id === id)?.answer?.options).toEqual([
    "yes",
  ]);
  rmSync(DECISIONS, { force: true });
});

const DANA_ID = "00000000-0000-4000-8000-000000000001";
const item: NamingQueueItem = {
  clips: [],
  conversations: 1,
  evidence: [],
  id: "v1",
  kind: "new_person",
  likely: [DANA_ID],
  name: null,
  namedPersonId: null,
  personId: null,
  voices: [{ conversationId: "c1", jobId: "job-1", speakerLabel: "A" }],
  words: 9,
};

test("a voice's answer goes to lifelog for every turn of it: a known person is assigned, an unknown one confirmed by name, nothing is written", async () => {
  const voice = check("voice:v1", "voice");
  const queue = spyOn(
    await import("../sources/lifelog-voices"),
    "readNamingQueue"
  ).mockResolvedValue([item]);
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    nameOf: (r: string) => (r === "person:dana" ? "Dana" : "Kofi"),
    resolve: (s: string) => (s === DANA_ID ? "person:dana" : null),
  } as never);
  const send = spyOn(
    await import("../sources/lifelog-voices"),
    "answerNamingQueue"
  ).mockResolvedValue({ personId: "p" });
  const voices = [{ jobId: "job-1", speakerLabel: "A" }];
  try {
    await answerCheck(voice, {
      options: ["this-is"],
      person: "person:dana",
    });
    await answerCheck(voice, {
      options: ["this-is"],
      person: "person:kofi",
    });
    await answerCheck(voice, { name: "Zed", options: ["this-is"] });
    await answerCheck(voice, { options: ["not-anyone-i-know"] });
    await answerCheck(voice, { options: ["media"] });
    await answerCheck(voice, { options: ["not-relevant"] });
    expect(send.mock.calls).toEqual([
      [voices, { kind: "assign", personId: DANA_ID }],
      [voices, { kind: "confirm", name: "Kofi" }],
      [voices, { kind: "confirm", name: "Zed" }],
      [voices, { kind: "ignore" }],
      [voices, { kind: "media" }],
      [voices, { kind: "not_relevant" }],
    ]);
    await expect(answerCheck(voice, { options: ["this-is"] })).rejects.toThrow(
      "give person or name"
    );
    queue.mockResolvedValue([]);
    await expect(answerCheck(voice, { options: ["media"] })).rejects.toThrow(
      "Not done: no open check voice:v1"
    );
    expect(said()).toEqual([]);
  } finally {
    send.mockRestore();
    people.mockRestore();
    queue.mockRestore();
  }
});

test("a new matter: Edit goal makes his words its goal, Dismiss is his no, Start makes the goal he saw his then asks the desk with it", async () => {
  const steps = ["obs_000000000071", "unit_000000000072"];
  const matter = check("matter_000000000007", "new matter");
  const view = (by: "life" | "owner", text: string) => ({
    goal: { at: "2026-11-17T02:00:00Z", by, text },
    id: matter.ref,
    steps: steps.map((ref) => ({ ref })),
  });
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue(
    {} as never
  );
  const book = spyOn(
    await import("./matters"),
    "readMatterBook"
  ).mockResolvedValue([view("life", "The boiler is serviced")] as never);
  try {
    await expect(
      answerCheck(matter, { options: ["edit-goal"] })
    ).rejects.toThrow("`note`");
    await answerCheck(matter, {
      note: "Serviced and the leak fixed",
      options: ["edit-goal"],
    });
    await answerCheck(matter, { options: ["dismiss"] });
    expect(started).toEqual([]);
    // Only his app's tap starts an agent: a session's answer (the CLI) cannot.
    await expect(
      answerWith(matter, { options: ["start"] }, "session")
    ).rejects.toThrow("his tap");
    const { done } = await answerCheck(matter, { options: ["start"] });
    expect(started).toEqual(["The boiler is serviced"]);
    expect(done.at(-1)).toEqual({ ask: "entry_000000000001" });
    // His own goal is already his word: Start writes nothing more.
    book.mockResolvedValue([view("owner", "Serviced by Friday")] as never);
    await answerCheck(matter, { options: ["start"] });
    expect(started.at(-1)).toBe("Serviced by Friday");
    expect(said()).toEqual([
      { goal: "Serviced and the leak fixed", kind: "matter-direction", steps },
      { kind: "new-matter-dismissed", steps },
      { goal: "The boiler is serviced", kind: "matter-direction", steps },
    ]);
  } finally {
    book.mockRestore();
    people.mockRestore();
  }
});
