import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { DAY } from "../core/clock";
import type { CheckGroup } from "../core/names";
import type { NamingQueueItem } from "../sources/lifelog-voices";
import { answerCheck as answerWith, type CheckAnswer } from "./answer-check";
import type { InboxCheck } from "./checks";
import { DECISIONS, decisionsNow, requestDecision } from "./decisions";
import type { Check } from "./life-checks";
import { CORRECTIONS, readCorrections } from "./memory-files";
import { samePersonRefOf } from "./same-person";
import { voiceCardRefOf } from "./who";

const check = (ref: string, group: CheckGroup, about: string[] = []) =>
  ({ about, group, kind: group, ref }) as unknown as InboxCheck;
const guess = check("person:inf_kit", "guessed person", [
  "Kit",
  "+33600000001",
]);
const name = check("name:kit", "name", ["Kit", "kit"]);
const card = check("person:con_kit", "contacts card");
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

test("his app may name the person as he typed it: only one person his truth/ or Contacts name, never a guess or a shared name", async () => {
  const readings: Record<string, object> = {
    // Only Life's guess goes by "Kit": refused.
    Kit: { by: "guess", isShared: false, ref: "person:inf_kit" },
    // A unique name in truth/: recorded, and his result shows who.
    "Kit Moreau": { by: "truth", isShared: false, ref: "person:kit" },
    // Two people in truth/ or his Contacts share "Sam": refused.
    Sam: { by: "contacts", isShared: true, ref: "person:con_sam" },
  };
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    nameOf: (r: string) => (r === "person:kit" ? "Kit Moreau" : r),
    readingNow: (n: string) => readings[n] ?? null,
  } as never);
  try {
    const answered = await answerCheck(card, {
      options: ["same-person"],
      person: "Kit Moreau",
    });
    expect(answered.recordedAs).toBe("Kit Moreau");
    await Promise.all(
      ["Kit", "Sam", "Nobody Known"].map((typed) =>
        expect(
          answerCheck(name, { options: ["this-is"], person: typed })
        ).rejects.toThrow(
          `Life doesn't know who "${typed}" is for sure; pick from the card or use their full name`
        )
      )
    );
    expect(said()).toEqual([
      { from: card.ref, kind: "same-person", to: "person:kit" },
    ]);
  } finally {
    people.mockRestore();
  }
});

test("a new person he names on a name check is the one person his truth/ or Contacts holds by that name, else added to his directory, once (life#721)", async () => {
  const readings: Record<string, object> = {
    // An organization of his: never his new person, nor a second party by that name.
    "Atelier Morel": { by: "truth", isShared: false, ref: "person:atelier" },
    // A unique name in truth/: that person, nobody added.
    "Kit Moreau": { by: "truth", isShared: false, ref: "person:kit" },
    // Only Life's guess goes by "Nora Vidal": his "New person" is his word, so she is added.
    "Nora Vidal": { by: "guess", isShared: false, ref: "person:inf_nora" },
    // Two people go by "Sam": his "New person" is a third.
    Sam: { by: "contacts", isShared: true, ref: "person:con_sam" },
  };
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    isOrganization: (r: string) => r === "person:atelier",
    nameOf: (r: string) => r,
    readingNow: (n: string) => readings[n] ?? null,
  } as never);
  const added: string[] = [];
  const relations: (string | undefined)[] = [];
  const addDirectoryEntry = (
    _kind: string,
    n: string,
    fields?: { relation?: string }
  ) => {
    added.push(n);
    relations.push(fields?.relation);
    const ref = `person:${n.toLowerCase().replace(" ", "-")}`;
    // Written: from now on truth/ holds the name.
    readings[n] = { by: "truth", isShared: false, ref };
    return Promise.resolve(ref);
  };
  const answer = (n: string, note?: string) =>
    answerWith(name, { name: n, note, options: ["this-is"] }, "connector", {
      addDirectoryEntry,
    });
  try {
    // Without `addDirectoryEntry` (a session, the command line), nobody is added.
    await expect(
      answerCheck(name, { name: "Nora Vidal", options: ["this-is"] })
    ).rejects.toThrow('Life knows no one called "Nora Vidal"');
    expect((await answer("Kit Moreau")).recordedAs).toBe("Kit Moreau");
    // His "Who they are" goes with the new person, as what they are to him.
    expect((await answer("Nora Vidal", "Nora's architect")).recordedAs).toBe(
      "Nora Vidal"
    );
    await answer("Sam");
    await expect(answer("Atelier Morel")).rejects.toThrow(
      '"Atelier Morel" is already an organization he knows'
    );
    // His same tap again (a retry): the name now reads from truth/, nobody is added twice.
    await answer("Nora Vidal");
    expect(added).toEqual(["Nora Vidal", "Sam"]);
    expect(relations).toEqual(["Nora's architect", undefined]);
    expect(said().map((c) => ("person" in c ? c.person : c.kind))).toEqual(
      [
        "person:kit",
        "person:nora-vidal",
        "person:sam",
        "person:nora-vidal",
      ].flatMap((p) => [p, p])
    );
  } finally {
    people.mockRestore();
  }
});

test("Organization on a name check adds it to his directory by his name for it (the card's by default) with his words as what it is, and every way it was written reads as it", async () => {
  const readings: Record<string, object> = {
    // A person he knows: never made an organization, nor a second party by that name.
    "Kit Moreau": { by: "truth", isShared: false, ref: "person:kit-moreau" },
    // Already his directory's: that organization, nothing added.
    "Test Bakery": { by: "truth", isShared: false, ref: "person:test-bakery" },
  };
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    isOrganization: (r: string) => r !== "person:kit-moreau",
    readingNow: (n: string) => readings[n] ?? null,
  } as never);
  const added: unknown[] = [];
  const answer = (a: Omit<CheckAnswer, "options">) =>
    answerWith(name, { ...a, options: ["organization"] }, "connector", {
      addDirectoryEntry: (kind, n, fields) => {
        added.push([kind, n, fields]);
        return Promise.resolve(`person:${n.toLowerCase()}`);
      },
    });
  try {
    await answer({ note: "his bike shop" });
    await answer({ name: "Test Bakery" });
    await expect(answer({ name: "Kit Moreau" })).rejects.toThrow(
      '"Kit Moreau" is already a person he knows'
    );
    expect(added).toEqual([
      ["organization", "Kit", { relation: "his bike shop" }],
    ]);
    expect(said()).toEqual([
      {
        kind: "this-is",
        nameOrHandle: "Kit",
        note: "his bike shop",
        person: "person:kit",
      },
      {
        kind: "this-is",
        nameOrHandle: "kit",
        note: "his bike shop",
        person: "person:kit",
      },
      { kind: "this-is", nameOrHandle: "Kit", person: "person:test-bakery" },
      { kind: "this-is", nameOrHandle: "kit", person: "person:test-bakery" },
    ]);
    // Without `addDirectoryEntry` (a session, the command line), nothing is added.
    await expect(
      answerCheck(name, { options: ["organization"] })
    ).rejects.toThrow('Life knows no one called "Kit"');
  } finally {
    people.mockRestore();
  }
});

test("Don't name on a name check: every way it was written is never asked again (life#724)", async () => {
  await answerCheck(name, { options: ["not-relevant"] });
  expect(said()).toEqual([
    { kind: "not-worth-naming", nameOrHandle: "Kit" },
    { kind: "not-worth-naming", nameOrHandle: "kit" },
  ]);
});

test("same person: Same person folds the guess into the other; Different people says each of its handles is not them", async () => {
  const pair = check(
    samePersonRefOf("person:inf_kit", "person:kit-lee"),
    "same person",
    ["@line__u1:beeper.local", "+33600000001"]
  );
  await answerCheck(pair, { options: ["same-person"] });
  await answerCheck(pair, { options: ["not-this-person"] });
  expect(said()).toEqual([
    { from: "person:inf_kit", kind: "same-person", to: "person:kit-lee" },
    {
      kind: "not-this-person",
      nameOrHandle: "@line__u1:beeper.local",
      person: "person:kit-lee",
    },
    {
      kind: "not-this-person",
      nameOrHandle: "+33600000001",
      person: "person:kit-lee",
    },
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
    context: "A made-up reason to ask.",
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
  personId: null,
  voices: [{ conversationId: "c1", jobId: "job-1", speakerLabel: "A" }],
  words: 9,
};

// life#765: a typed name is resolved with the people the voice answer already read: one read, not two.
test("a voice answer naming someone by a typed name reads his people once", async () => {
  const resolve = (s: string) => (s === DANA_ID ? "person:dana" : null);
  const voice = check(voiceCardRefOf(resolve, item), "voice");
  const queue = spyOn(
    await import("../sources/lifelog-voices"),
    "readNamingQueueNow"
  ).mockResolvedValue([item]);
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    nameOf: () => "Dana",
    readingNow: (typed: string) =>
      typed === "Dana"
        ? { by: "his word", isShared: false, ref: "person:dana" }
        : undefined,
    resolve,
  } as never);
  const send = spyOn(
    await import("../sources/lifelog-voices"),
    "answerNamingQueue"
  ).mockResolvedValue({ personId: "p" });
  try {
    await answerCheck(voice, { options: ["this-is"], person: "Dana" });
    expect(people).toHaveBeenCalledTimes(1);
    expect(send.mock.calls).toEqual([
      [
        [{ jobId: "job-1", speakerLabel: "A" }],
        { kind: "assign", personId: DANA_ID },
      ],
    ]);
  } finally {
    queue.mockRestore();
    people.mockRestore();
    send.mockRestore();
  }
});

test("a voice's answer goes to lifelog for every turn of it: a known person is assigned, an unknown one confirmed by name, nothing is written", async () => {
  const resolve = (s: string) => (s === DANA_ID ? "person:dana" : null);
  const voice = check(voiceCardRefOf(resolve, item), "voice");
  const queue = spyOn(
    await import("../sources/lifelog-voices"),
    "readNamingQueueNow"
  ).mockResolvedValue([item]);
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    nameOf: (r: string) => (r === "person:dana" ? "Dana" : "Kofi"),
    resolve,
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
    // "Yes" to the guess in use: the check's subject, with nothing else given.
    const known = { ...item, kind: "known_person" as const, personId: DANA_ID };
    queue.mockResolvedValueOnce([known]);
    const dana = {
      ...voice,
      ref: voiceCardRefOf(resolve, known),
      subject: "person:dana",
    };
    // "Yes" names the person on the card only: a typed name goes with "Someone else…".
    await expect(
      answerCheck(dana, { name: "Kofi", options: ["is-them"] })
    ).rejects.toThrow('"Yes" names the person');
    queue.mockResolvedValueOnce([known]);
    await answerCheck(dana, { options: ["is-them"] });
    await answerCheck(voice, { options: ["not-anyone-i-know"] });
    await answerCheck(voice, { options: ["media"] });
    await answerCheck(voice, { options: ["not-relevant"] });
    expect(send.mock.calls).toEqual([
      [voices, { kind: "assign", personId: DANA_ID }],
      [voices, { kind: "confirm", name: "Kofi" }],
      [voices, { kind: "confirm", name: "Zed" }],
      [voices, { kind: "assign", personId: DANA_ID }],
      [voices, { kind: "ignore" }],
      [voices, { kind: "media" }],
      [voices, { kind: "not_relevant" }],
    ]);
    await expect(answerCheck(voice, { options: ["this-is"] })).rejects.toThrow(
      "give person or name"
    );
    await expect(answerCheck(voice, { options: ["is-them"] })).rejects.toThrow(
      "give person or name"
    );
    // The card he saw changed in lifelog (now several people, another suggestion, or one more recording): nothing is sent.
    const sent = send.mock.calls.length;
    for (const now of [
      { ...known, kind: "several" as const },
      { ...known, personId: null },
      {
        ...known,
        voices: [
          ...known.voices,
          { conversationId: "c2", jobId: "job-2", speakerLabel: "B" },
        ],
      },
    ]) {
      queue.mockResolvedValueOnce([now]);
      // biome-ignore lint/performance/noAwaitInLoops: each case uses the queue it just set
      await expect(answerCheck(dana, { options: ["is-them"] })).rejects.toThrow(
        `no open check ${dana.ref}`
      );
    }
    expect(send.mock.calls.length).toBe(sent);
    queue.mockResolvedValue([]);
    await expect(answerCheck(voice, { options: ["media"] })).rejects.toThrow(
      `Not done: no open check ${voice.ref}`
    );
    expect(said()).toEqual([]);
  } finally {
    send.mockRestore();
    people.mockRestore();
    queue.mockRestore();
  }
});

test("a new matter: Edit goal makes his words its goal, Dismiss is his no, Start asks the desk with the goal he saw and writes nothing itself", async () => {
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
    ).rejects.toThrow("his own answer_check");
    const { done } = await answerCheck(matter, { options: ["start"] });
    expect(done).toEqual([{ ask: "entry_000000000001" }]);
    // The goal he saw, sent with his tap, wins over one re-drafted since (the desk's start saves it as his).
    book.mockResolvedValue([view("life", "Re-drafted since")] as never);
    await answerCheck(matter, {
      note: "The boiler is serviced",
      options: ["start"],
    });
    expect(started).toEqual([
      "The boiler is serviced",
      "The boiler is serviced",
    ]);
    expect(said()).toEqual([
      { goal: "Serviced and the leak fixed", kind: "matter-direction", steps },
      { kind: "new-matter-dismissed", steps },
    ]);
  } finally {
    book.mockRestore();
    people.mockRestore();
  }
});

test("your move: Mark as done ends its step through host, Not now pins his word for 3 days, Hand to an agent only while offered", async () => {
  const steps: [string, string] = ["obs_000000000081", "obs_000000000082"];
  const move = {
    ...check("move:matter_000000000081/obs_000000000081", "your move"),
    goal: "The garden fence is painted",
    matter: { id: "matter_000000000081", name: "Garden fence" },
    options: [{ id: "done" }, { id: "start" }, { id: "not-now" }],
    subject: steps[0],
  } as unknown as InboxCheck;
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue(
    {} as never
  );
  const book = spyOn(
    await import("./matters"),
    "readMatterBook"
  ).mockResolvedValue([
    {
      id: "matter_000000000081",
      open: true,
      steps: steps.map((ref) => ({ ref })),
    },
  ] as never);
  const ended: string[] = [];
  try {
    const { done } = await answerWith(
      move,
      { options: ["done"] },
      "connector",
      {
        endYourMove: () => {
          ended.push(move.subject ?? "");
          return Promise.resolve([{ kind: "outdated" }]);
        },
      }
    );
    expect(done).toEqual([{ kind: "outdated" }]);
    expect(ended).toEqual([steps[0]]);
    await expect(
      answerWith(move, { options: ["done"] }, "session")
    ).rejects.toThrow("his own answer_check");
    await answerCheck(move, { options: ["not-now"] });
    const [line] = said();
    expect(line).toMatchObject({
      kind: "your-move-not-now",
      matter: "matter_000000000081",
      steps,
    });
    expect(
      (line as { until: string }).until > new Date().toISOString().slice(0, 10)
    ).toBe(true);
    await answerCheck(move, { options: ["start"] });
    expect(started).toEqual(["The garden fence is painted"]);
    await expect(
      answerCheck({ ...move, options: [{ id: "done" }] } as never, {
        options: ["start"],
      })
    ).rejects.toThrow("while the card offers it");
  } finally {
    book.mockRestore();
    people.mockRestore();
  }
});
