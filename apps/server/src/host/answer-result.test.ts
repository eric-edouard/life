import { Database } from "bun:sqlite";
import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { DAY } from "../core/clock";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import type { InboxCheck } from "../memory/checks";
import type { Decision } from "../memory/decision-lines";
import {
  DECISIONS,
  decisionsNow,
  notSentOf,
  requestDecision,
} from "../memory/decisions";
import type { Check } from "../memory/life-checks";
import { CORRECTIONS, readCorrections } from "../memory/memory-files";
import { voiceCardRefOf } from "../memory/who";
import type { NamingQueueItem } from "../sources/lifelog-voices";
import { answerWithResult } from "./answer-result";
import { expectWire } from "./http/wire-fixture";

// Made-up people, chats and ids throughout.

const draft = { channel: "whatsapp", text: "Can you come Friday?", to: "Kit" };
const readChat = () =>
  Promise.resolve({ ...draft, chat: "155@s.whatsapp.net", to: "Kit Moreau" });
const OPTIONS = [
  { id: "send", label: "Send it", outgoing: true as const },
  { id: "wait", label: "Wait" },
];
const card = (asker = "planner", agent?: string) =>
  requestDecision(
    asker,
    {
      ...(agent ? { agent } : {}),
      context: "A made-up reason to ask.",
      deadline: new Date(Date.now() + 2 * DAY).toISOString(),
      draft,
      onSilence: "wait",
      options: OPTIONS,
      question: "Send Kit the message?",
      title: "Ask Kit",
    },
    undefined,
    readChat
  );

const asCheck = (c: Partial<Check>) =>
  ({ about: [], matter: null, pushId: "", ...c }) as InboxCheck;
/** The inbox as it is: the open decisions, plus made-up guesses. */
let guesses: InboxCheck[] = [];
let listed: ReturnType<typeof spyOn>;
let sends: ReturnType<typeof spyOn>;
beforeEach(async () => {
  rmSync(DECISIONS, { force: true });
  rmSync(CORRECTIONS, { force: true });
  guesses = [];
  listed = spyOn(
    await import("../memory/checks"),
    "checksNow"
  ).mockImplementation(async () => [
    ...decisionsNow()
      .filter((d) => d.state === "open")
      .map((d) =>
        asCheck({ deadline: d.deadline, group: "decision", ref: d.id })
      ),
    ...guesses,
  ]);
  sends = spyOn(await import("../memory/draft-send"), "sendDraft");
});
afterEach(() => {
  listed.mockRestore();
  sends.mockRestore();
});
afterAll(() => {
  rmSync(DECISIONS, { force: true });
  rmSync(CORRECTIONS, { force: true });
});

/** Runs a call and keeps every step it reports. */
const call = (
  ref: string,
  options: string[],
  answerKey?: string,
  extra = {}
) => {
  const steps: Record<string, unknown>[] = [];
  const result = answerWithResult(
    ref,
    { options, ...extra },
    { ...(answerKey ? { answerKey } : {}), report: (s) => steps.push(s) }
  );
  return { result, steps };
};

test("a send: the plan first, the steps in order, the lines written, the send and the asker, no inbox", async () => {
  sends.mockImplementation(
    (
      _d: unknown,
      _t: unknown,
      o: { onStep?: (s: string, d?: object) => void }
    ) => {
      o.onStep?.("chat_checked");
      o.onStep?.("handed");
      o.onStep?.("confirmed", { eventId: "$ev1" });
      return Promise.resolve("$ev1");
    }
  );
  const { id } = await card();
  const { result, steps } = call(id, ["send"], "tap-1");
  const r = await result;
  expectWire("answer_check_sent", r, true);
  expect(steps.map((s) => s.plan ?? s.step)).toEqual([
    ["recorded", "chat_checked", "handed", "confirmed"],
    "recorded",
    "chat_checked",
    "handed",
    "confirmed",
  ]);
  expect(steps[0]).toMatchObject({ limitSeconds: 45 });
  expect(steps.find((s) => s.step === "confirmed")).toMatchObject({
    eventId: "$ev1",
  });
  expect(r).toMatchObject({
    asker: { name: "planner", told: "on_its_next_poll" },
    changed: { decision: id, options: ["send"], state: "answered" },
    kind: "decision",
    ref: id,
    send: {
      channel: "whatsapp",
      eventId: "$ev1",
      state: "sent",
      to: "Kit Moreau",
    },
  });
  expect(r).not.toHaveProperty("inbox");
  expect(r.done).toMatchObject([
    { answerKey: "tap-1", kind: "answered" },
    { eventId: "$ev1", kind: "sent" },
  ]);
});

// 19 Nov 2026: the phone showed a failed send that had gone out; the second tap carried a new key and was refused.
test("an answered decision asked the same answer again under a new key: its first result, nothing sent, nothing written; another answer is refused", async () => {
  sends.mockResolvedValue("$ev9");
  const { id } = await card();
  const first = await call(id, ["send"], "tap-1").result;
  const lines = readFileSync(DECISIONS, "utf8");
  expect(await call(id, ["send"], "tap-2").result).toEqual(first);
  expect(await call(id, ["send"]).result).toEqual(first);
  expect(sends).toHaveBeenCalledTimes(1);
  expect(readFileSync(DECISIONS, "utf8")).toBe(lines);
  await expect(call(id, ["wait"], "tap-3").result).rejects.toThrow(
    "Not done: no open check"
  );
  expect(sends).toHaveBeenCalledTimes(1);
});

// A registered agent's desk that never queues: the answer once waited 5 s for it.
test("an asker whose desk never queues is not waited for: the result comes at the proof", async () => {
  const { id } = await card("desk", "agt_0123456789ab");
  const started = performance.now();
  const { result, steps } = call(id, ["wait"], "tap-w");
  const r = await result;
  expect(performance.now() - started).toBeLessThan(2000);
  expect(steps[0]?.plan).toEqual(["recorded"]);
  expect(steps.map((s) => s.step).filter(Boolean)).toEqual(["recorded"]);
  expect(r).not.toHaveProperty("inbox");
  expect(r.asker).toMatchObject({ told: "not_yet" });
});

test("a not-sent outcome reopens the card: the result says so and whether to try again; the same tap again returns it, a new tap sends once", async () => {
  sends.mockRejectedValueOnce(
    new Error("not sent: someone wrote in Kit Moreau since this card was asked")
  );
  const { id } = await card();
  const first = await call(id, ["send"], "tap-1").result;
  expectWire("answer_check_not_sent", first, true);
  expect(first).toMatchObject({
    asker: { told: "not_told" },
    changed: { options: ["send"], state: "open" },
    send: {
      canRetry: true,
      reason: expect.stringContaining("someone wrote"),
      state: "not_sent",
    },
  });
  // The tap again (a dropped stream): the stored result, no second send.
  const again = await call(id, ["send"], "tap-1").result;
  expect(again).toMatchObject({ send: { state: "not_sent" } });
  expect(sends).toHaveBeenCalledTimes(1);
  expect(decisionsNow()[0]?.notSent).toBeDefined();
  // His new tap sends, with the attempt's instant as its baseline.
  sends.mockResolvedValueOnce("$ev2");
  const second = await call(id, ["send"], "tap-2").result;
  expect(second).toMatchObject({ send: { eventId: "$ev2", state: "sent" } });
  expect(sends).toHaveBeenCalledTimes(2);
  expect(sends.mock.calls[1]?.[2]).toMatchObject({
    since: new Date(decisionsNow()[0]?.notSent?.at ?? ""),
  });
  // And the same tap again after it sent: the stored sent, nothing more.
  const third = await call(id, ["send"], "tap-2").result;
  expect(third).toMatchObject({ send: { eventId: "$ev2", state: "sent" } });
  expect(sends).toHaveBeenCalledTimes(2);
});

test("an older not-sent tap replayed returns its own stored result and sends nothing; a different key and answer on an open call is refused", async () => {
  sends.mockRejectedValueOnce(new Error("not sent: someone wrote"));
  sends.mockRejectedValueOnce(new Error("not sent: someone wrote again"));
  const { id } = await card();
  await call(id, ["send"], "tap-a").result;
  await call(id, ["send"], "tap-b").result;
  expect(sends).toHaveBeenCalledTimes(2);
  const replay = await call(id, ["send"], "tap-a").result;
  expect(replay).toMatchObject({
    send: {
      reason: expect.stringContaining("someone wrote"),
      state: "not_sent",
    },
  });
  expect(sends).toHaveBeenCalledTimes(2);
  sends.mockImplementation(
    () => new Promise((r) => setTimeout(() => r("$e"), 50))
  );
  const first = call(id, ["send"], "x").result;
  await expect(call(id, ["wait"], "y").result).rejects.toThrow("Not done");
  await first;
  sends.mockReset();
});

test("a late not-sent, after the card's deadline, cannot be retried", async () => {
  const { id } = await card();
  const d = decisionsNow().find((x) => x.id === id);
  expect(
    notSentOf({ ...(d as Decision), deadline: "2020-01-01T00:00:00.000Z" }, {
      at: "2026-01-01T00:00:00.000Z",
      error: "not sent: x",
    } as never)?.canRetry
  ).toBe(false);
});

test("a never-retryable not-sent says canRetry false; may have gone stays answered", async () => {
  sends.mockRejectedValueOnce(
    Object.assign(new Error("not sent: the file is gone"), { canRetry: false })
  );
  const { id } = await card();
  expect((await call(id, ["send"], "a").result).send).toMatchObject({
    canRetry: false,
    state: "not_sent",
  });
  sends.mockRejectedValueOnce(new Error("may have gone: no answer"));
  expect((await call(id, ["send"], "b").result).send).toMatchObject({
    canRetry: false,
    state: "may_have_gone",
  });
  // The same answer again is its first result; another answer finds no open check.
  expect((await call(id, ["send"], "c").result).send).toMatchObject({
    state: "may_have_gone",
  });
  await expect(call(id, ["wait"], "c").result).rejects.toThrow(
    "Not done: no open check"
  );
  expect(sends).toHaveBeenCalledTimes(2);
});

test("two calls at once on one check: one answer, both get its result", async () => {
  sends.mockResolvedValue("$ev3");
  const { id } = await card();
  const [a, b] = await Promise.all([
    call(id, ["send"]).result,
    call(id, ["send"]).result,
  ]);
  expect(a).toBe(b);
  expect(sends).toHaveBeenCalledTimes(1);
});

// 19 Nov 2026 (review A, B2): two keyless calls with different answers: the second was handed the first's result as its own.
test("two calls at once with different answers: the second is refused, keyed or not; only the first is written", async () => {
  sends.mockImplementation(
    () => new Promise((r) => setTimeout(() => r("$e"), 50))
  );
  const { id } = await card();
  const first = call(id, ["send"]).result;
  await expect(call(id, ["wait"]).result).rejects.toThrow("another answer to");
  await expect(call(id, ["wait"], "same").result).rejects.toThrow(
    "another answer to"
  );
  expect((await first).changed).toMatchObject({ options: ["send"] });
  sends.mockReset();
});

// PR 600's verdict: two "it is this person" answers at once naming different people: the second got the first's result.
test("two calls at once naming different people, or a new person by another name: the second is refused", async () => {
  guesses = [asCheck({ about: ["Sam"], group: "name", ref: "name:sam" })];
  const first = call("name:sam", ["this-is"], undefined, {
    person: "person:gran",
  }).result;
  await expect(
    call("name:sam", ["this-is"], undefined, { person: "person:partner" })
      .result
  ).rejects.toThrow("another answer to");
  await expect(
    call("name:sam", ["this-is"], undefined, { name: "Sam Lee" }).result
  ).rejects.toThrow("another answer to");
  expect(await first).toMatchObject({ changed: { person: "person:gran" } });
  expect(readCorrections()).toMatchObject([{ person: "person:gran" }]);
});

test("a decision without a send: its plan has no send steps", async () => {
  const { id } = await card();
  const { result, steps } = call(id, ["wait"]);
  const r = await result;
  expect(steps[0]?.plan).toEqual(["recorded"]);
  expect(r.send).toBeNull();
  expect(sends).not.toHaveBeenCalled();
});

test("a registered agent's asker: not yet without a desk, queued then woken as the desk's rows say", async () => {
  const { id } = await card("desk", "agt_0123456789ab");
  setSettings({ desk: { defaultRuntime: "claude", runtimes: { claude: {} } } });
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  // Only the tables the answer's reader asks, and the columns it reads.
  mkdirSync(dirname(DESK_STORE), { recursive: true });
  const db = new Database(DESK_STORE, { create: true, strict: true });
  db.run(
    "create table assignment (id text, agent_id text, closed_at text, opened_at text, matter_id text)"
  );
  db.run("create table anchor (assignment_id text, step text)");
  db.run("create table card (decision_id text, assignment_id text)");
  db.run(
    "insert into assignment values ('asg_test', 'agt_0123456789ab', null, '2026-11-18T08:00:00.000Z', null)"
  );
  db.run(
    "create table event (assignment_id text, event_id text, name text, payload text, received_at text)"
  );
  db.run(
    "create table turn (agent_id text, assignment_id text, cause text, started_at text, ended_at text)"
  );
  try {
    const r = await call(id, ["wait"]).result;
    expect(r.asker).toMatchObject({
      agent: "agt_0123456789ab",
      told: "not_yet",
    });
    const { id: id2 } = await card("desk", "agt_0123456789ab");
    db.run(
      "insert into event (assignment_id, event_id, name, payload, received_at) values (?, ?, ?, ?, ?)",
      [
        "asg_test",
        `${id2}.answered`,
        "decision.answered",
        "{}",
        "2026-11-18T09:00:00.000Z",
      ]
    );
    expect((await call(id2, ["wait"]).result).asker).toMatchObject({
      told: "queued",
    });
    const { id: id3 } = await card("desk", "agt_0123456789ab");
    db.run(
      "insert into event (assignment_id, event_id, name, payload, received_at) values (?, ?, ?, ?, ?)",
      [
        "asg_test",
        `${id3}.answered`,
        "decision.answered",
        "{}",
        "2026-11-18T09:00:00.000Z",
      ]
    );
    db.run(
      "insert into turn (agent_id, assignment_id, cause, started_at) values (?, ?, ?, ?)",
      ["agt_0123456789ab", "asg_test", "answer", "2026-11-18T09:00:05.000Z"]
    );
    expect((await call(id3, ["wait"]).result).asker).toMatchObject({
      told: "woken",
    });
    // Folded or moved to another agent: the receipt names the agent holding its card now.
    const { id: id4 } = await card("desk", "agt_0123456789ab");
    db.run("insert into card values (?, 'asg_test'), (?, 'asg_test')", [
      id3,
      id4,
    ]);
    db.run("update assignment set agent_id = 'agt_00000000fe11'");
    // The one that woke on it stays the one told, after its card moved on.
    expect((await call(id3, ["wait"]).result).asker).toMatchObject({
      agent: "agt_0123456789ab",
      told: "woken",
    });
    expect((await call(id4, ["wait"]).result).asker).toMatchObject({
      agent: "agt_00000000fe11",
    });
  } finally {
    db.close();
    setSettings({ desk: null });
    rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  }
}, 15_000);

test("each kind says what changed: an ending, a person (two parallel calls write once), a voice with its counts", async () => {
  const record = spyOn(
    await import("../memory/fact-checks"),
    "recordFactCheckAnswer"
  ).mockResolvedValue({} as never);
  const item: NamingQueueItem = {
    clips: [],
    conversations: 2,
    evidence: [],
    id: "v1",
    isLikely: false,
    kind: "new_person",
    likely: [],
    name: null,
    personId: null,
    voices: [
      { conversationId: "c1", jobId: "job-1", speakerLabel: "A" },
      { conversationId: "c1", jobId: "job-1", speakerLabel: "B" },
      { conversationId: "c2", jobId: "job-2", speakerLabel: "A" },
    ],
    words: 9,
  };
  const voiceRef = voiceCardRefOf(() => null, item);
  guesses = [
    asCheck({
      group: "ending",
      matter: { id: "matter_1", name: "Boiler" },
      ref: "obs_000000000001",
    }),
    asCheck({
      about: ["Kit", "+33600000001"],
      group: "guessed person",
      ref: "person:inf_kit",
    }),
    asCheck({ group: "voice", ref: voiceRef }),
  ];
  const queue = spyOn(
    await import("../sources/lifelog-voices"),
    "readNamingQueueNow"
  ).mockResolvedValue([item]);
  const send = spyOn(
    await import("../sources/lifelog-voices"),
    "answerNamingQueue"
  ).mockResolvedValue({ personId: "p1" });
  try {
    const ended = await call("obs_000000000001", ["outdated"], "tap-e", {
      note: "paid",
    }).result;
    // The same tap again after a dropped connection: its stored result, not "no open check".
    expect(
      await call("obs_000000000001", ["outdated"], "tap-e", { note: "paid" })
        .result
    ).toBe(ended);
    expect(ended).toMatchObject({
      asker: { told: "recorded" },
      changed: {
        ending: "done",
        matter: { id: "matter_1" },
        step: "obs_000000000001",
      },
      kind: "ending",
      send: null,
    });
    const [x, y] = await Promise.all([
      call("person:inf_kit", ["this-is"]).result,
      call("person:inf_kit", ["this-is"]).result,
    ]);
    expect(x).toBe(y);
    expect(x).toMatchObject({
      changed: {
        corrections: 1,
        names: ["Kit", "+33600000001"],
        person: "person:inf_kit",
      },
    });
    expect(readCorrections()).toHaveLength(1);
    const { steps, result } = call(voiceRef, ["media"]);
    expect(await result).toMatchObject({
      changed: { answer: "media", conversations: 2, person: "p1", voices: 3 },
    });
    expect(steps.map((s) => s.plan ?? s.step)).toEqual([
      ["recorded"],
      "recorded",
    ]);
    await expect(call("person:none", ["this-is"]).result).rejects.toThrow(
      "Not done: no open check"
    );
  } finally {
    record.mockRestore();
    queue.mockRestore();
    send.mockRestore();
  }
});

test("a new matter: Start asks the desk with the goal he saw, reports its stages in one plan and returns the desk's result; Edit goal keeps the card", async () => {
  const steps = ["obs_000000000071", "unit_000000000072"];
  const newMatter = asCheck({
    group: "new matter",
    matter: { id: "matter_000000000007", name: "Boiler service" },
    ref: "matter_000000000007",
  });
  guesses = [newMatter];
  const people = spyOn(
    await import("../memory/who"),
    "readPeople"
  ).mockResolvedValue({} as never);
  const book = spyOn(
    await import("../memory/matters"),
    "readMatterBook"
  ).mockResolvedValue([
    {
      goal: {
        at: "2026-11-17T02:00:00Z",
        by: "life",
        text: "The boiler is serviced",
      },
      id: newMatter.ref,
      steps: steps.map((ref) => ({ ref })),
    },
  ] as never);
  const started = readStarted();
  const desk = spyOn(
    await import("./change-registered-agent"),
    "changeRegisteredAgent"
  ).mockImplementation((_change, c) => {
    c?.report({
      limitSeconds: 20,
      plan: ["goal_saved", "desk_accepted", "session_open", "turn_begun"],
    });
    c?.report({ at: "2026-11-18T10:00:00.000Z", step: "goal_saved" });
    for (const { stage, ...detail } of started.stages) {
      c?.report({ step: stage, ...detail });
    }
    // The desk anchors its agent on the matter: the card leaves.
    guesses = [];
    return Promise.resolve(started as never);
  });
  try {
    const edited = await call(newMatter.ref, ["edit-goal"], "tap-g", {
      note: "Serviced and the leak fixed",
    }).result;
    expectWire("answer_check_new_matter_goal_edited", edited, true);
    expect(edited).toMatchObject({
      changed: { answer: "edit-goal", goal: "Serviced and the leak fixed" },
      start: null,
    });
    // The goal he saw is his edit, though the matter still reads Life's draft.
    const { result, steps: reported } = call(
      newMatter.ref,
      ["start"],
      "tap-s",
      {
        note: "Serviced and the leak fixed",
      }
    );
    const r = await result;
    expectWire("answer_check_new_matter_started", r, true);
    expect(reported.map((s) => s.plan ?? s.step)).toEqual([
      ["goal_saved", "desk_accepted", "session_open", "turn_begun", "recorded"],
      "goal_saved",
      "desk_accepted",
      "session_open",
      "turn_begun",
      "recorded",
    ]);
    expect(reported[0]).toMatchObject({ limitSeconds: 25 });
    expect(desk.mock.calls[0]?.[0]).toEqual({
      action: "start",
      said: "Serviced and the leak fixed",
      step: newMatter.ref,
    });
    expect(r).toMatchObject({
      kind: "new matter",
      start: { state: "started" },
    });
    expect(
      readCorrections().map(({ at: _a, schemaVersion: _v, ...c }) => c)
    ).toEqual([
      { goal: "Serviced and the leak fixed", kind: "matter-direction", steps },
    ]);
    // The same tap again after a dropped stream: its result, no second ask of the desk.
    expect(
      await call(newMatter.ref, ["start"], "tap-s", {
        note: "Serviced and the leak fixed",
      }).result
    ).toBe(r);
    expect(desk).toHaveBeenCalledTimes(1);
  } finally {
    desk.mockRestore();
    book.mockRestore();
    people.mockRestore();
  }
});

/** The desk's answer to a start, as the phone's fixture has it: one that began, else `not_started`. */
function readStarted(name = "started") {
  return JSON.parse(
    readFileSync(
      join(
        import.meta.dir,
        `../../../lifelog/fixtures/wire/life/change_registered_agent_${name}.json`
      ),
      "utf8"
    )
  ) as { stages: { stage: string }[] };
}

test("a new matter's Start the desk did not start: the result says where it stopped, the card stays, and his next tap starts again", async () => {
  const newMatter = asCheck({
    group: "new matter",
    matter: { id: "matter_000000000008", name: "Frame the photo" },
    ref: "matter_000000000008",
  });
  guesses = [newMatter];
  const people = spyOn(
    await import("../memory/who"),
    "readPeople"
  ).mockResolvedValue({} as never);
  const book = spyOn(
    await import("../memory/matters"),
    "readMatterBook"
  ).mockResolvedValue([
    {
      goal: {
        at: "2026-11-17T02:00:00Z",
        by: "owner",
        text: "The photo is framed",
      },
      id: newMatter.ref,
      steps: [{ ref: "obs_000000000081" }],
    },
  ] as never);
  const desk = spyOn(
    await import("./change-registered-agent"),
    "changeRegisteredAgent"
  )
    .mockResolvedValueOnce(readStarted("not_started") as never)
    .mockResolvedValueOnce(readStarted() as never);
  try {
    const refused = await call(newMatter.ref, ["start"], "tap-1").result;
    expect(refused).toMatchObject({
      start: { failed: { stage: "desk_accepted" }, state: "not_started" },
    });
    expect(guesses).toEqual([newMatter]);
    // The same tap's retry after a dropped stream gets its failed result: the desk is not asked again.
    expect(await call(newMatter.ref, ["start"], "tap-1").result).toMatchObject({
      start: { state: "not_started" },
    });
    expect(desk).toHaveBeenCalledTimes(1);
    const again = await call(newMatter.ref, ["start"], "tap-2").result;
    expect(again).toMatchObject({ start: { state: "started" } });
    expect(desk).toHaveBeenCalledTimes(2);
  } finally {
    desk.mockRestore();
    book.mockRestore();
    people.mockRestore();
  }
});

test("goal A, then B, then A again records three times: a fresh answer ends the memory of the earlier ones", async () => {
  const newMatter = asCheck({
    group: "new matter",
    matter: { id: "matter_000000000009", name: "Paint the door" },
    ref: "matter_000000000009",
  });
  guesses = [newMatter];
  const people = spyOn(
    await import("../memory/who"),
    "readPeople"
  ).mockResolvedValue({} as never);
  const book = spyOn(
    await import("../memory/matters"),
    "readMatterBook"
  ).mockResolvedValue([
    {
      goal: { at: "2026-11-17T02:00:00Z", by: "owner", text: "Door painted" },
      id: newMatter.ref,
      steps: [{ ref: "obs_000000000091" }],
    },
  ] as never);
  try {
    await call(newMatter.ref, ["edit-goal"], "tap-0", { note: "A" }).result;
    await call(newMatter.ref, ["edit-goal"], "tap-1", { note: "B" }).result;
    await call(newMatter.ref, ["edit-goal"], "tap-2", { note: "A" }).result;
    expect(readCorrections().map((c) => (c as { goal?: string }).goal)).toEqual(
      ["A", "B", "A"]
    );
  } finally {
    book.mockRestore();
    people.mockRestore();
  }
});

// life#765: the tapped voice card is the group he saw. Grown by a recording since: refused, nothing sent. The same
// recordings in another order: the same card, accepted.
test("a voice card's tap: refused with no write once its group grew, accepted when only reordered", async () => {
  const shown: NamingQueueItem = {
    clips: [],
    conversations: 1,
    evidence: [],
    id: "v2",
    isLikely: false,
    kind: "new_person",
    likely: [],
    name: null,
    personId: null,
    voices: [
      { conversationId: "c1", jobId: "job-1", speakerLabel: "A" },
      { conversationId: "c2", jobId: "job-2", speakerLabel: "A" },
    ],
    words: 9,
  };
  const voiceRef = voiceCardRefOf(() => null, shown);
  guesses = [asCheck({ group: "voice", ref: voiceRef })];
  const grown = {
    ...shown,
    voices: [
      ...shown.voices,
      { conversationId: "c3", jobId: "job-3", speakerLabel: "B" },
    ],
  };
  const queue = spyOn(
    await import("../sources/lifelog-voices"),
    "readNamingQueueNow"
  ).mockResolvedValue([grown]);
  const send = spyOn(
    await import("../sources/lifelog-voices"),
    "answerNamingQueue"
  ).mockResolvedValue({ personId: "p1" });
  try {
    await expect(call(voiceRef, ["media"], "tap-g").result).rejects.toThrow(
      "no open check"
    );
    expect(send).not.toHaveBeenCalled();
    queue.mockResolvedValue([{ ...shown, voices: shown.voices.toReversed() }]);
    expect(await call(voiceRef, ["media"], "tap-r").result).toMatchObject({
      changed: { answer: "media" },
    });
    expect(send).toHaveBeenCalledTimes(1);
  } finally {
    queue.mockRestore();
    send.mockRestore();
  }
});

test("your move: Mark as done closes only its step, never a sibling; Drop closes the same way, recorded as dropped; each fresh Not now press is its own answer, the same press retried writes once", async () => {
  const step = (ref: string) => ({
    at: "2026-11-01T09:00:00.000Z",
    day: "2026-11-01",
    kind: "to_do",
    quote: "it",
    ref,
    text: "Paint the gate",
  });
  const [mine, sibling] = [step("obs_000000000071"), step("obs_000000000072")];
  const move = asCheck({
    group: "your move",
    matter: { id: "matter_000000000007", name: "Garden gate" },
    options: [
      { ends: "step", id: "done", label: "Mark as done", takes: null },
      { id: "not-now", label: "Not now", takes: null },
    ],
    ref: `move:matter_000000000007/${mine.ref}`,
    subject: mine.ref,
    title: "Garden gate",
  });
  // His Drop (21 Nov 2026), on the sibling's card: the same ending as Mark as done, recorded as dropped.
  const drop = asCheck({
    ...move,
    options: [{ ends: "step", id: "drop", label: "Drop", takes: null }],
    ref: `move:matter_000000000007/${sibling.ref}`,
    subject: sibling.ref,
  });
  guesses = [move, drop];
  const people = spyOn(
    await import("../memory/who"),
    "readPeople"
  ).mockResolvedValue({} as never);
  const book = spyOn(
    await import("../memory/matters"),
    "readMatterBook"
  ).mockResolvedValue([
    { id: "matter_000000000007", open: true, steps: [mine, sibling] },
  ] as never);
  try {
    const nn = "your-move-not-now";
    await call(move.ref, ["done"], "tap-done").result;
    await call(drop.ref, ["drop"], "tap-drop").result;
    await call(move.ref, ["not-now"], "tap-1").result;
    await call(move.ref, ["not-now"], "tap-1").result;
    await call(move.ref, ["not-now"], "tap-2").result;
    expect(
      readCorrections().map((c) =>
        c.kind === "outdated" ? [...c.observations, c.outcome] : c.kind
      )
    ).toEqual([[mine.ref, undefined], [sibling.ref, "dropped"], nn, nn]);
  } finally {
    book.mockRestore();
    people.mockRestore();
  }
});
