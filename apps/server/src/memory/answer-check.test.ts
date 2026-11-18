import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import type { NamingQueueItem } from "../sources/lifelog-voices";
import { answerCheck } from "./answer-check";
import type { CheckGroup, InboxCheck } from "./checks";
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
let listed: ReturnType<typeof spyOn>;

beforeEach(async () => {
  rmSync(CORRECTIONS, { force: true });
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
    title: "Cheapest.",
  });
  listed.mockResolvedValue([check(id, "decision")]);
  await answerCheck(id, { options: ["yes"] });
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
  listed.mockResolvedValue([voice]);
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
    await answerCheck(voice.ref, {
      options: ["this-is"],
      person: "person:dana",
    });
    await answerCheck(voice.ref, {
      options: ["this-is"],
      person: "person:kofi",
    });
    await answerCheck(voice.ref, { name: "Zed", options: ["this-is"] });
    await answerCheck(voice.ref, { options: ["not-anyone-i-know"] });
    await answerCheck(voice.ref, { options: ["media"] });
    await answerCheck(voice.ref, { options: ["not-relevant"] });
    expect(send.mock.calls).toEqual([
      [voices, { kind: "assign", personId: DANA_ID }],
      [voices, { kind: "confirm", name: "Kofi" }],
      [voices, { kind: "confirm", name: "Zed" }],
      [voices, { kind: "ignore" }],
      [voices, { kind: "media" }],
      [voices, { kind: "not_relevant" }],
    ]);
    await expect(
      answerCheck(voice.ref, { options: ["this-is"] })
    ).rejects.toThrow("give person or name");
    queue.mockResolvedValue([]);
    await expect(
      answerCheck(voice.ref, { options: ["media"] })
    ).rejects.toThrow("Not done: no open check voice:v1");
    expect(said()).toEqual([]);
  } finally {
    send.mockRestore();
    people.mockRestore();
    queue.mockRestore();
  }
});
