import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import { answerCheck as answerWith, type CheckAnswer } from "./answer-check";
import type { Check, CheckGroup } from "./checks";
import { DECISIONS, decisionsNow, requestDecision } from "./decisions";
import { CORRECTIONS, readCorrections } from "./memory-files";

const check = (ref: string, group: CheckGroup, about: string[] = []) =>
  ({ about, group, kind: group, ref }) as unknown as Check;
/** The starts host was asked for (a matter start's Start). */
let started: Check[] = [];
const answerCheck = (ref: string, a: CheckAnswer) =>
  answerWith(ref, a, {
    startAgent: (c) => {
      started.push(c);
      return Promise.resolve("Done: start agt_000000000001");
    },
  });
const guess = check("person:inf_kit", "guessed person", [
  "Kit",
  "+33600000001",
]);
const name = check("name:kit", "name", ["Kit", "kit"]);
const card = check("person:con_kit", "card");
const ending = check("obs_000000000001", "ending");
let listed: ReturnType<typeof spyOn>;

beforeEach(async () => {
  rmSync(CORRECTIONS, { force: true });
  started = [];
  listed = spyOn(await import("./checks"), "checksNow").mockResolvedValue([
    guess,
    name,
    card,
    ending,
  ]);
});
afterEach(() => listed.mockRestore());

const said = () =>
  readCorrections().map(({ at: _at, schemaVersion: _v, ...c }) => c);

test("a guessed person: yes confirms it by one name, no refuses each of its names, someone else folds it into them", async () => {
  await answerCheck(guess.ref, { note: "my plumber", options: ["this-is"] });
  await answerCheck(guess.ref, { options: ["not-this-person"] });
  await expect(
    answerCheck(guess.ref, { options: ["same-person"] })
  ).rejects.toThrow("`person`");
  await answerCheck(guess.ref, {
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
  await answerCheck(name.ref, { options: ["this-is"], person: "person:kit" });
  await answerCheck(card.ref, {
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
    await answerCheck(ending.ref, { note: "paid", options: ["outdated"] });
    expect(record).toHaveBeenCalledWith(ending.ref, "outdated", "paid");
  } finally {
    record.mockRestore();
  }
});

test("one option of the check's own; an unknown ref, option or a second option is refused, writing nothing", async () => {
  await Promise.all(
    (
      [
        ["obs_000000000009", ["outdated"]],
        [ending.ref, ["this-is"]],
        [ending.ref, ["constructor"]],
        [ending.ref, []],
        [guess.ref, ["this-is", "not-this-person"]],
      ] as const
    ).map(([ref, options]) =>
      expect(answerCheck(ref, { options: [...options] })).rejects.toThrow(
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
    recommended: ["yes"],
    why: "Cheapest.",
  });
  listed.mockResolvedValue([check(id, "decision")]);
  await answerCheck(id, { options: ["yes"] });
  expect(decisionsNow().find((d) => d.id === id)?.answer?.options).toEqual([
    "yes",
  ]);
  rmSync(DECISIONS, { force: true });
});

test("a matter start: Edit goal records his goal, Dismiss his no, Start asks host to start an agent, then records it", async () => {
  const start = {
    ...check("start:obs_000000000002", "matter start"),
    subject: "obs_000000000002",
  } as Check;
  listed.mockResolvedValue([start]);
  await expect(
    answerCheck(start.ref, { options: ["edit-goal"] })
  ).rejects.toThrow("`note`");
  await answerCheck(start.ref, {
    note: "The boiler is serviced before winter",
    options: ["edit-goal"],
  });
  await answerCheck(start.ref, { options: ["dismiss"] });
  expect(said()).toEqual([
    {
      goal: "The boiler is serviced before winter",
      kind: "matter-goal",
      steps: ["obs_000000000002"],
    },
    { answer: "dismiss", kind: "matter-start", steps: ["obs_000000000002"] },
  ]);
  expect(started).toEqual([]);
  const { done } = await answerCheck(start.ref, { options: ["start"] });
  expect(done[0]).toBe("Done: start agt_000000000001");
  expect(started).toEqual([start]);
  expect(said().at(-1)).toEqual({
    answer: "start",
    kind: "matter-start",
    steps: ["obs_000000000002"],
  });
});
