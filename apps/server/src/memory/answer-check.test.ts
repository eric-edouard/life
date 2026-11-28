import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, DAY } from "../core/clock";
import type { CheckGroup } from "../core/names";
import type { NamingQueueItem } from "../sources/voice-speakers";
import {
  answerCheck as answerWith,
  type CheckAnswer,
  LATER,
  laterOf,
  laterTimeOf,
} from "./answer-check";
import type { InboxCheck } from "./checks";
import { DECISIONS } from "./decision-lines";
import { decisionsNow, requestDecision } from "./decisions";
import type { Check } from "./life-checks";
import { laterUntilOf } from "./matters";
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
  isLikely: false,
  kind: "new_person",
  likely: [DANA_ID],
  name: null,
  personId: null,
  voices: [{ conversationId: "c1", jobId: "job-1", speakerLabel: "A" }],
  words: 9,
};

/** The people a voice card's ref is read with, of a made-up `resolve`. */
const whoOf = (resolve: (s: string) => string | null) => ({
  names: new Map([["person:dana", "Dana"]]),
  refOf: (r: string) => r,
  resolve,
  truth: { people: [] },
});

// Voice answers released together (the phone's held answers): each reads lifelog's queue after the one before it
// landed, so all land, and one that fails does not stop the next.
test("voice answers given at once are read and answered one at a time, and all land", async () => {
  const resolve = () => null;
  const items = ["v1", "v2", "v3"].map((id, i) => ({
    ...item,
    id,
    voices: [{ conversationId: "c1", jobId: `job-${i}`, speakerLabel: "A" }],
  }));
  let open = [...items];
  const seen: string[] = [];
  const voices = await import("../sources/voice-speakers");
  const queue = spyOn(voices, "readNamingQueueNow").mockImplementation(
    async () => {
      const now = open;
      await Bun.sleep(1);
      seen.push(`read ${now.map((i) => i.id).join()}`);
      return now;
    }
  );
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    ...whoOf(resolve),
  } as never);
  const send = spyOn(voices, "answerNamingQueue").mockImplementation(
    async ([v]) => {
      // The first answer is slow and fails: the next still waits for it, then lands.
      if (v?.jobId === "job-0") {
        await Bun.sleep(20);
        seen.push("fail v1");
        throw new Error("lifelog is down");
      }
      open = open.filter((i) => i.voices[0]?.jobId !== v?.jobId);
      seen.push(`answer ${v?.jobId}`);
      return { ok: true };
    }
  );
  try {
    const answers = await Promise.allSettled(
      items.map((i) =>
        answerCheck(check(voiceCardRefOf(whoOf(resolve), i), "voice"), {
          options: ["not-relevant"],
        })
      )
    );
    expect(answers.map((a) => a.status)).toEqual([
      "rejected",
      "fulfilled",
      "fulfilled",
    ]);
    expect(seen).toEqual([
      "read v1,v2,v3",
      "fail v1",
      "read v1,v2,v3",
      "answer job-1",
      "read v1,v3",
      "answer job-2",
    ]);
  } finally {
    queue.mockRestore();
    people.mockRestore();
    send.mockRestore();
  }
});

// life#765: a typed name is resolved with the people the voice answer already read: one read, not two.
test("a voice answer naming someone by a typed name reads his people once", async () => {
  const resolve = (s: string) => (s === DANA_ID ? "person:dana" : null);
  const voice = check(voiceCardRefOf(whoOf(resolve), item), "voice");
  const queue = spyOn(
    await import("../sources/voice-speakers"),
    "readNamingQueueNow"
  ).mockResolvedValue([item]);
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    nameOf: () => "Dana",
    readingNow: (typed: string) =>
      typed === "Dana"
        ? { by: "his word", isShared: false, ref: "person:dana" }
        : undefined,
    ...whoOf(resolve),
  } as never);
  const send = spyOn(
    await import("../sources/voice-speakers"),
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
  const voice = check(voiceCardRefOf(whoOf(resolve), item), "voice");
  const queue = spyOn(
    await import("../sources/voice-speakers"),
    "readNamingQueueNow"
  ).mockResolvedValue([item]);
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    nameOf: (r: string) => (r === "person:dana" ? "Dana" : "Kofi"),
    ...whoOf(resolve),
  } as never);
  const send = spyOn(
    await import("../sources/voice-speakers"),
    "answerNamingQueue"
  ).mockResolvedValue({ personId: "p" });
  // The voice naming guessed Dana for the voices lifelog calls Dana: the card asks "Is this Dana?".
  const guesses = spyOn(
    await import("./voice-guesses"),
    "withVoiceGuesses"
  ).mockImplementation(async (items) =>
    items.map((i) => ({
      ...i,
      guessed: i.personId === DANA_ID ? ["person:dana"] : [],
      names: {},
      whys: {},
    }))
  );
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
    // A new name goes as typed, a slash in it too (his report of 22 Nov).
    await answerCheck(voice, { name: "Zed/Zeda", options: ["this-is"] });
    // "Yes" to the guess in use: the check's subject, with nothing else given.
    const known = {
      ...item,
      guessed: ["person:dana"],
      kind: "known_person" as const,
      personId: DANA_ID,
    };
    queue.mockResolvedValueOnce([known]);
    const dana = {
      ...voice,
      ref: voiceCardRefOf(whoOf(resolve), known),
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
      [voices, { kind: "confirm", name: "Zed/Zeda" }],
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
        "no longer open"
      );
    }
    expect(send.mock.calls.length).toBe(sent);
    queue.mockResolvedValue([]);
    await expect(answerCheck(voice, { options: ["media"] })).rejects.toThrow(
      "no longer open"
    );
    expect(said()).toEqual([]);
  } finally {
    guesses.mockRestore();
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

test("your move: Mark as done ends its step through host, Not now is his Later on its ref, Hand to an agent only while offered", async () => {
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
    expect(line).toMatchObject({ kind: "deferred", ref: move.ref });
    expect(Date.parse((line as { until: string }).until)).toBeGreaterThan(
      clock().getTime()
    );
    // Later holds the matter whole: its card about a newer step (or the migrated `move:<matter>`) stays held.
    expect(laterUntilOf("move:matter_000000000081/obs_newer")).toBe(
      (line as { until: string }).until
    );
    expect(laterUntilOf("move:matter_000000000082/obs_newer")).toBe(undefined);
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

test("someone else, named as a person lifelog knows by an id the card does not list, is assigned that id (life#963)", async () => {
  const KOFI_ID = "00000000-0000-4000-8000-000000000002";
  const resolve = (s: string) =>
    ({ [DANA_ID]: "person:dana", Kofi: "person:kofi" })[s] ?? null;
  const voices = await import("../sources/voice-speakers");
  const voice = check(voiceCardRefOf(whoOf(resolve), item), "voice");
  const queue = spyOn(voices, "readNamingQueueNow").mockResolvedValue([item]);
  const names = spyOn(voices, "readVoiceNames").mockResolvedValue({
    [KOFI_ID]: "Kofi",
  });
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    nameOf: () => "Kofi",
    ...whoOf(resolve),
  } as never);
  const send = spyOn(voices, "answerNamingQueue").mockResolvedValue({
    personId: "p",
  });
  try {
    await answerCheck(voice, { options: ["this-is"], person: "person:kofi" });
    expect(send.mock.calls).toEqual([
      [
        [{ jobId: "job-1", speakerLabel: "A" }],
        { kind: "assign", personId: KOFI_ID },
      ],
    ]);
  } finally {
    queue.mockRestore();
    names.mockRestore();
    people.mockRestore();
    send.mockRestore();
  }
});

// His report of 22 Nov: a voice that was his own could not be named him. Naming him assigns lifelog's owner id, never
// a new person by his directory name.
test("a voice named him is assigned to lifelog's owner, and refused before lifelog has heard him", async () => {
  const resolve = (s: string) => (s === DANA_ID ? "person:dana" : null);
  const voice = check(voiceCardRefOf(whoOf(resolve), item), "voice");
  const lifelog = await import("../sources/voice-speakers");
  const queue = spyOn(lifelog, "readNamingQueueNow").mockResolvedValue([item]);
  const owner = spyOn(lifelog, "readOwnerVoiceId").mockResolvedValue(
    "owner-id"
  );
  const people = spyOn(await import("./who"), "readPeople").mockResolvedValue({
    nameOf: () => "Test Owner",
    ...whoOf(resolve),
  } as never);
  const send = spyOn(lifelog, "answerNamingQueue").mockResolvedValue({
    personId: "owner-id",
  });
  try {
    await answerCheck(voice, { options: ["this-is"], person: "person:me" });
    expect(send.mock.calls).toEqual([
      [
        [{ jobId: "job-1", speakerLabel: "A" }],
        { kind: "assign", personId: "owner-id" },
      ],
    ]);
    owner.mockResolvedValueOnce(undefined);
    await expect(
      answerCheck(voice, { options: ["this-is"], person: "person:me" })
    ).rejects.toThrow("has not heard you");
    expect(send.mock.calls.length).toBe(1);
  } finally {
    queue.mockRestore();
    owner.mockRestore();
    people.mockRestore();
    send.mockRestore();
  }
});

test("Later on any check is one deferred correction by its ref: it holds until its time, the latest for a ref wins, and it writes nothing else", async () => {
  const { done } = await answerCheck(ending, { options: [LATER] });
  const { until } = done[0] as { until: string };
  expect(said()).toEqual([{ kind: "deferred", ref: ending.ref, until }]);
  expect(laterUntilOf(ending.ref)).toBe(until);
  expect(laterUntilOf(ending.ref, new Date(Date.parse(until) + 1))).toBe(
    undefined
  );
  expect(laterUntilOf(guess.ref)).toBe(undefined);
  await expect(
    answerCheck(ending, { options: [LATER, "outdated"] })
  ).rejects.toThrow("pick one");
});

test("Life's time for Later: tomorrow 9:00, sooner before a deadline, never sooner than 30 minutes; a later instruction's time of day wins", () => {
  const now = new Date("2026-11-20T10:00:00.000Z");
  const tomorrow = Date.parse(
    laterOf({ deadline: null, matter: null }, now, undefined)
  );
  expect(tomorrow).toBeGreaterThan(now.getTime() + 12 * 3_600_000);
  const deadline = "2026-11-20T18:00:00.000Z";
  expect(laterOf({ deadline, matter: null }, now, undefined)).toBe(
    "2026-11-20T15:00:00.000Z"
  );
  expect(
    laterOf(
      { deadline: "2026-11-20T11:00:00.000Z", matter: null },
      now,
      undefined
    )
  ).toBe("2026-11-20T10:30:00.000Z");
  expect(laterTimeOf("this evening")).toBe("18:00");
  expect(laterTimeOf("at 7pm")).toBe("19:00");
  expect(laterTimeOf("after 21:30")).toBe("21:30");
  expect(laterTimeOf("whenever")).toBe(undefined);
  const evening = Date.parse(
    laterOf({ deadline: null, matter: null }, now, "this evening")
  );
  expect(evening).toBeGreaterThan(now.getTime());
  expect(evening - now.getTime()).toBeLessThan(DAY);
  expect(laterOf({ deadline: null, matter: null }, now, "when I'm home")).toBe(
    "2026-11-21T10:00:00.000Z"
  );
});
