import { expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock, DAY } from "../core/clock";
import type { Correction } from "../records/observation";
import type { NamingQueueItem } from "../sources/lifelog-voices";
import { shownStepsOf } from "./check-sentences";
import { urgencyOf } from "./check-urgency";
import {
  type CheckInputs,
  checksNow,
  checksOf,
  checksOnMatterOf,
  pushIdOf,
} from "./checks";
import { about, DANA_ID, inputs, line, stepsOf } from "./checks-test-inputs";
import { checksText } from "./checks-text";
import type { AgentHold } from "./held-matters";
import type { Check } from "./life-checks";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matters from "./matters";
import { OBSERVATIONS, UNITS } from "./memory-files";
import { locked } from "./memory-lock";

/** One registered agent anchored on `step`, active unless `over` says otherwise (`heldByAgents`' facts). */
const anchored = (step: string, over: Partial<AgentHold> = {}): AgentHold[] => [
  {
    endedAt: null,
    kind: "asked",
    outcome: null,
    project: null,
    step,
    whyNotStarted: null,
    ...over,
  },
];

const ASKED_UNTIL_22_NOV =
  /Next step: Book the plumber\. Asked until .*22 Nov\.$/;

const ID = "inf_kit";
const REF = `person:${ID}`;

test("a guess nothing rides on gives no check; three lines on one guess give one check riding three", () => {
  const none = inputs([line()], { inferred: [ID] });
  expect(checksOf(none)).toEqual([]);
  // A name said once, on a line below the kept ones, rides on nothing either.
  const small = line();
  expect(
    checksOf({
      ...none,
      kept: new Set(),
      unresolved: [{ nameAsWritten: "Dre", observation: small.id }],
    })
  ).toEqual([]);
  const lines = [about(REF), about(REF), about(REF), about("person:zoe")];
  const [check, ...more] = checksOf(inputs(lines, { inferred: [ID] }));
  expect(more).toEqual([]);
  expect(check).toMatchObject({
    kind: "person",
    ref: REF,
    ridesOn: { matters: 0, observations: 3, pages: 0 },
  });
  // The identity ask: "Is this <whole name>?", and why Life thinks so in one sentence.
  expect(check?.question).toBe("Is this Kit inf_kit?");
  // Life's guess is its recommendation, listed first; on silence nothing is taken; its kind gives the title and context.
  expect(check).toMatchObject({
    asker: "life",
    context: "Life read their messages as Kit inf_kit, the plumber (70% sure).",
    draft: null,
    onSilence: null,
    title: "Know who someone is",
  });
  expect(check?.options.map((o) => o.id)).toEqual([
    "this-is",
    "not-this-person",
    "same-person",
  ]);
  expect(check?.about).toEqual(["+33600000001"]);
  const printed = checksText([check as Check]);
  expect(printed).toContain(`1. [guessed person] ${REF}: Is this Kit inf_kit?`);
  expect(printed).toContain("about: +33600000001");
  expect(check?.evidence?.quote).toBe(`${ID} said hello`);
});

test("his word, this-is or same-person to the guess, removes the check; a not-this-person on one handle does not", () => {
  const lines = [about(REF)];
  const at = "2026-10-03T10:00:00.000Z";
  const thisIs: Correction = {
    at,
    kind: "this-is",
    nameOrHandle: "+33600000001",
    person: "person:zoe",
    schemaVersion: 1,
  };
  const confirmed: Correction = { ...thisIs, person: REF };
  const merged: Correction = {
    at,
    from: "person:inf_other",
    kind: "same-person",
    schemaVersion: 1,
    to: REF,
  };
  // He refused one of two handles the guess goes by: the person is still a guess.
  const refused: Correction = {
    at,
    kind: "not-this-person",
    nameOrHandle: "+33600000001",
    person: REF,
    schemaVersion: 1,
  };
  const checks = (corrections: Correction[]) =>
    checksOf(inputs(lines, { corrections, inferred: [ID] }));
  expect(checks([])).toHaveLength(1);
  expect(checks([thisIs, refused])).toHaveLength(1);
  expect(checks([confirmed])).toEqual([]);
  expect(checks([merged])).toEqual([]);
});

test("the order: open matters, then lines, then pages, then the newest", () => {
  const a = about("person:inf_a");
  const b = about("person:inf_b");
  const c = [about("person:inf_c"), about("person:inf_c")];
  const d = about("person:inf_d");
  const e = about("person:inf_e", { date: "2026-10-09" });
  const lines = [a, b, ...c, d, e];
  const order = checksOf(
    inputs(lines, {
      inferred: ["inf_a", "inf_b", "inf_c", "inf_d", "inf_e"],
      matters: [
        {
          id: "matter_aaaaaaaaaaaa",
          lone: false,
          name: "Fix the gate",
          open: true,
          owedTo: [],
          projects: [] as string[],
          status: "moving" as const,
          steps: stepsOf(a.id),
          waitingOn: [],
          with: [],
        },
      ],
      paged: new Set(["person:inf_d"]),
    })
  ).map((x) => x.ref);
  expect(order).toEqual([
    "person:inf_a",
    "person:inf_c",
    "person:inf_d",
    "person:inf_e",
    "person:inf_b",
  ]);
});

// Everything `bun life memory questions` listed (guessed people, ambiguous cards, names not placed) is in the list,
// with no cap of 25: that command and its file are gone.
test("the list holds every guessed person, ambiguous card and unplaced name that something rides on, past 25", () => {
  const names = Array.from({ length: 30 }, (_, i) => `Name${i}`);
  const nameLines = names.map((x) => line({ text: x }));
  const lines = [about(REF), about("person:con_card"), ...nameLines];
  const checks = checksOf(
    inputs(lines, {
      cards: [{ card: "person:con_card", people: ["person:a", "person:b"] }],
      inferred: [ID],
      unresolved: names.map((x, i) => ({
        nameAsWritten: x,
        observation: (nameLines[i] as { id: string }).id,
      })),
    })
  );
  const kinds = checks.map((x) => x.ref);
  // A name check's button never names the unknown name; a card two people fit makes no one's name the answer.
  const first = (r: string) => checks.find((x) => x.ref === r)?.options[0];
  expect(first("name:name0")?.label).toBe("Someone else…");
  expect(first("person:con_card")?.label).toBe("Someone else…");
  expect(kinds).toHaveLength(32);
  expect(kinds).toContain(REF);
  expect(kinds).toContain("person:con_card");
  expect(kinds.filter((r) => r.startsWith("name:"))).toHaveLength(30);
});

test("a person two guesses fold into is asked once, through the one they fold into", () => {
  const checks = checksOf(
    inputs([about("person:inf_a")], {
      folds: { "person:inf_b": "person:inf_a" },
      inferred: ["inf_a", "inf_b"],
    })
  );
  expect(checks.map((x) => x.ref)).toEqual(["person:inf_a"]);
});

test("an ending rides on its open matter and goes with his answer", () => {
  const o = line({ text: "Send the quote." });
  const matter = {
    id: "matter_aaaaaaaaaaaa",
    lone: false,
    name: "Send the quote",
    open: true,
    owedTo: [],
    projects: [] as string[],
    status: "moving" as const,
    steps: stepsOf(o.id),
    waitingOn: [],
    with: [],
  };
  const base = inputs([o], {
    endings: new Map([[o.id, { later: "ep_000000000001", quote: "Sent it." }]]),
    kept: new Set(),
    matters: [matter],
    titles: new Map([[o.unit, "Camille and Kit"]]),
  });
  const [ending] = checksOf(base);
  expect(ending).toMatchObject({
    evidence: { quote: "Sent it." },
    kind: "ending",
    matter: { id: "matter_aaaaaaaaaaaa", name: "Send the quote" },
    // The open step is `said` (who, to whom, when) and what came since is `since`; the question stays short.
    question: "Is this done?",
    ref: o.id,
    ridesOn: { matters: 1, observations: 0 },
    said: {
      at: "2026-10-01",
      by: "Camille",
      channel: "whatsapp",
      text: "I'll bring it Friday",
      to: "Camille and Kit",
    },
    since: { at: null, by: null, text: "Sent it." },
  });
  expect(checksOf({ ...base, answered: new Set([o.id]) })).toEqual([]);
  // An old doubt line on the same ref: an answer by ref would land on it, so no ending check.
  expect(checksOf({ ...base, doubted: new Set([o.id]) })).toEqual([]);
});

const decision = (id: string, deadline: string, subject?: string) => ({
  asker: "planner",
  at: "2026-11-18T09:00:00.000Z",
  context: "",
  deadline,
  id,
  kind: "asked" as const,
  links: [],
  onSilence: null,
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  question: `Go ahead with ${id}?`,
  schemaVersion: 3 as const,
  state: "open" as const,
  ...(subject ? { subject } : {}),
  title: "It is due.",
});

test("open decisions come first, soonest deadline first; one on a step leaves with its matter, one on a project stays", () => {
  const o = line();
  const matter = (open: boolean) => ({
    id: "matter_bbbbbbbbbbbb",
    lone: false,
    name: "Boiler repair",
    open,
    owedTo: [],
    projects: [] as string[],
    status: "moving" as const,
    steps: stepsOf(o.id),
    waitingOn: [],
    with: [],
  });
  const base = inputs([about(REF), about(REF)], {
    decisions: [
      decision("dec_00000000000a", "2026-11-20T09:00:00.000Z", o.id),
      decision(
        "dec_00000000000b",
        "2026-11-19T09:00:00.000Z",
        "project:boiler"
      ),
    ],
    inferred: [ID],
    matters: [matter(true)],
  });
  const list = checksOf(base);
  expect(list.map((c) => c.ref)).toEqual([
    "dec_00000000000b",
    "dec_00000000000a",
    REF,
  ]);
  expect(list[1]).toMatchObject({
    asker: "planner",
    group: "decision",
    matter: { id: "matter_bbbbbbbbbbbb", name: "Boiler repair" },
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Go ahead with dec_00000000000a?",
    ridesOn: { matters: 1 },
    subject: o.id,
  });
  expect(
    checksOf({ ...base, matters: [matter(false)] }).map((c) => c.ref)
  ).toEqual(["dec_00000000000b", REF]);
  // A step no matter holds any more (a re-group) keeps its decision.
  expect(checksOf({ ...base, matters: [] }).map((c) => c.ref)).toEqual([
    "dec_00000000000b",
    "dec_00000000000a",
    REF,
  ]);
});

const voice = (id: string, over: Partial<NamingQueueItem> = {}) =>
  ({
    clips: [
      {
        at: "2026-10-01T10:00:00.000Z",
        audio: { end: 4, jobId: "job-1", start: 1 },
        text: "See you Friday",
        until: null,
        words: [
          [0, 400, 3],
          [500, 700, 4],
          [800, 1400, 7],
        ],
      },
    ],
    conversations: 3,
    evidence: [
      {
        at: "2026-10-01T10:00:00.000Z",
        conversationId: "c1",
        text: "See you Friday",
      },
    ],
    id,
    kind: "new_person",
    likely: [DANA_ID, "00000000-0000-4000-8000-000000000002"],
    name: null,
    personId: null,
    voices: [{ conversationId: "c1", jobId: "job-1", speakerLabel: "A" }],
    words: 40,
    ...over,
  }) satisfies NamingQueueItem;

test("every voice in lifelog's queue is a check in the inbox, with its clips and the people it may be", () => {
  const items = Array.from({ length: 60 }, (_, i) => voice(`v${i}`));
  items[0] = voice("v0", { kind: "known_person", personId: DANA_ID });
  items[1] = voice("v1", { name: "Kofi" });
  // One he called several people is not asked in v1: one answer would give all its turns to one person.
  const cards = checksOf(
    inputs([], { voices: [...items, voice("v60", { kind: "several" })] })
  ).filter((c) => c.group === "voice");
  expect(cards).toHaveLength(60);
  const byRef = (r: string) => cards.find((c) => c.ref === r);
  // Lifelog's suggestion in use is asked as a guess; the rest are asked who.
  expect(byRef("voice:v0")?.question).toBe("Is this Dana?");
  expect(byRef("voice:v1")?.question).toBe("Who is this?");
  expect(byRef("voice:v1")?.about).toEqual(["Kofi"]);
  expect(byRef("voice:v2")?.question).toBe("Who is this?");
  expect(byRef("voice:v2")?.likelyPeople).toEqual([
    { line: null, name: "Dana", person: "person:dana" },
  ]);
  expect(byRef("voice:v2")?.clips[0]?.audio).toEqual({
    end: 4,
    jobId: "job-1",
    start: 1,
  });
  expect(byRef("voice:v2")?.clips[0]?.words).toEqual([
    [0, 400, 3],
    [500, 700, 4],
    [800, 1400, 7],
  ]);
  // The people it could be are buttons of their own; the answers are "Yes" (only to a guess in use), "Someone else…", "Don't name".
  const labels = (r: string) => byRef(r)?.options.map((o) => o.label);
  expect(labels("voice:v0")).toEqual(["Yes", "Someone else…", "Don't name"]);
  expect(labels("voice:v1")).toEqual(["Someone else…", "Don't name"]);
  expect(labels("voice:v2")).toEqual(["Someone else…", "Don't name"]);
  expect(byRef("voice:v2")?.evidence?.quote).toBe("See you Friday");
  // Lifelog ranks likely people for every voice: only its suggestion makes a guess in use.
  expect(
    cards.filter((c) => urgencyOf(c) === "improves").map((c) => c.ref)
  ).toEqual(["voice:v0"]);
});

const HEX16 = /^[0-9a-f]{16}$/;
test("a push id is 16 hex, stable for a ref, and differs under another key", () => {
  const id = pushIdOf("person:kit", "a".repeat(64));
  expect(id).toMatch(HEX16);
  expect(pushIdOf("person:kit", "a".repeat(64))).toBe(id);
  expect(pushIdOf("person:kit", "b".repeat(64))).not.toBe(id);
  expect(pushIdOf("person:lou", "a".repeat(64))).not.toBe(id);
  expect(id).not.toContain("kit");
});

test("a new matter an agent could move asks 'Start an agent on this?' for 7 days from its first step, with no deadline, until he answers it", () => {
  const steps = [
    {
      at: "2026-11-16T09:00:00.000Z",
      day: "2026-11-16",
      quote: "the boiler is leaking",
      ref: "obs_000000000071",
    },
    {
      at: "2026-11-17T09:00:00.000Z",
      day: "2026-11-17",
      quote: "call the plumber",
      ref: "unit_000000000072",
    },
  ];
  const matter = {
    goal: {
      at: "2026-11-17T02:00:00Z",
      by: "life" as const,
      text: "The boiler is serviced.",
    },
    id: "matter_000000000007",
    lone: false,
    name: "Boiler service",
    newestOpenStep: {
      at: "2026-11-17T02:00:00Z",
      day: "2026-11-17",
      kind: "to_do" as const,
      quote: "call the plumber",
      ref: "unit_000000000072",
      text: "call the plumber",
    },
    nextStep: {
      at: "2026-11-17T02:00:00Z",
      by: "life" as const,
      kind: "do" as const,
      text: "Book the plumber",
    },
    open: true,
    owedTo: [],
    projects: [] as string[],
    status: "moving" as const,
    steps,
    waitingOn: [],
    with: [],
  };
  const base = inputs([], { matters: [matter] });
  expect(checksOf(base)).toEqual([
    {
      about: [],
      around: null,
      asker: "life",
      at: null,
      clips: [],
      confirm: [],
      context: expect.stringMatching(ASKED_UNTIL_22_NOV),
      deadline: null,
      draft: null,
      evidence: {
        from: expect.stringContaining("16 Nov"),
        quote: "the boiler is leaking",
      },
      goal: "The boiler is serviced.",
      group: "new matter",
      kind: "new matter",
      likelyPeople: [],
      links: [],
      matter: { id: matter.id, name: "Boiler service" },
      notSent: null,
      onMatters: [{ id: matter.id, name: "Boiler service" }],
      // 19 Nov 2026 (review A, B5): it held a sentence where every other kind holds an option id.
      onSilence: null,
      options: [
        expect.objectContaining({ id: "start" }),
        expect.objectContaining({ id: "edit-goal" }),
        expect.objectContaining({ id: "dismiss" }),
      ],
      question: "Start an agent on this?",
      ref: matter.id,
      ridesOn: {
        matterIds: [matter.id],
        matters: 1,
        observations: 0,
        pages: 0,
      },
      // The step it began with, as far as Life knows who said it (a step that is no line has only its day and words).
      said: {
        at: "2026-11-16",
        by: null,
        channel: null,
        text: "the boiler is leaking",
        to: null,
      },
      since: null,
      subject: null,
      title: "Life found a new matter: Boiler service",
    },
  ]);
  // His goal, once he edits it, is what it asks about.
  const edited = {
    ...matter,
    goal: {
      ...matter.goal,
      by: "owner" as const,
      text: "Serviced and the leak fixed",
    },
  };
  expect(checksOf({ ...base, matters: [edited] })[0]?.goal).toBe(
    "Serviced and the leak fixed"
  );
  // Its last day is the 7th from its first step; it never outranks an agent's decision.
  expect(checksOf({ ...base, today: "2026-11-22" })).toHaveLength(1);
  // Finding 4 of the action pipeline review (20 Nov 2026): with the hand-out on, a project's agent holds none of its
  // project's matters, as for the hand-out; off, it still answers for them and no Start is offered.
  const projectAgent = anchored("", { project: "test-shop", step: null });
  const inShop = [{ ...matter, projects: ["test-shop"] }];
  expect(
    checksOf({
      ...base,
      heldByAgents: projectAgent,
      isHandOutOn: true,
      matters: inShop,
    })
  ).toHaveLength(1);
  expect(
    checksOf({ ...base, heldByAgents: projectAgent, matters: inShop })
  ).toEqual([]);
  // An agent that ended holds its matter until a newer step.
  expect(
    checksOf({
      ...base,
      heldByAgents: anchored("obs_000000000071", {
        endedAt: "2026-11-17T01:00:00.000Z",
      }),
    })
  ).toHaveLength(1);
  const none = (over: Partial<CheckInputs>) => checksOf({ ...base, ...over });
  const wait = {
    ...matter.nextStep,
    kind: "wait_event" as const,
    waitsOn: "the plumber",
  };
  for (const list of [
    none({ today: "2026-11-23" }),
    none({ heldByAgents: null }),
    none({ heldByAgents: anchored("unit_000000000072") }),
    none({
      heldByAgents: anchored("obs_000000000071", {
        endedAt: "2026-11-17T09:00:00.000Z",
      }),
    }),
    // The hand-out is on and it is one of his: the hand-out takes it, no Start.
    none({ isForHandOut: (id) => id === matter.id }),
    none({ dismissed: [["obs_000000000071"]] }),
    none({ matters: [{ ...matter, goal: undefined }] }),
    none({ matters: [{ ...matter, nextStep: wait }] }),
    none({ matters: [{ ...matter, lone: true }] }),
    none({ matters: [{ ...matter, open: false, status: "done" as const }] }),
    none({ matters: [{ ...matter, status: "dormant" as const }] }),
    // stale-1-finished-matter-offered: nothing left to do (a repair done), though it runs and has a `do` next step.
    none({ matters: [{ ...matter, newestOpenStep: undefined }] }),
    // stale-3-plan-past-its-event: its newest open step's date has passed, so it is stuck.
    none({
      matters: [
        {
          ...matter,
          newestOpenStep: { ...matter.newestOpenStep, when: "2026-11-17" },
          status: "stuck" as const,
        },
      ],
    }),
    // An open decision on one of its steps: its next step is his decision.
    none({
      decisions: [
        decision(
          "dec_00000000000c",
          "2026-11-25T09:00:00.000Z",
          "obs_000000000071"
        ),
      ],
    }).filter((c) => c.group === "new matter"),
  ]) {
    expect(list).toEqual([]);
  }
  // Dismissed, then re-grouped under a new id with one more step: still dismissed.
  const regrouped = {
    ...matter,
    id: "matter_000000000008",
    steps: [
      ...steps,
      {
        at: "2026-11-18T09:00:00.000Z",
        day: "2026-11-18",
        quote: "plumber booked",
        ref: "obs_000000000073",
      },
    ],
  };
  expect(
    checksOf({
      ...base,
      dismissed: [steps.map((s) => s.ref)],
      matters: [regrouped],
    })
  ).toEqual([]);
});

// 19 Nov 2026 (review A, B3 and R1): a run that took and let go of the lock between two of the watcher's looks never
// pushed its cards, and every reader read every episode and observation on every call. Then (PR 600's verdict): a key
// on the lock's release changed with each of the watcher's unit syncs, every 5 minutes.
test("the inbox is read again only when what it reads changed: not a unit sync; a run's lines, an agent's hold, a new day", async () => {
  const reads = spyOn(matters, "readMatterRecords");
  const day = join(OBSERVATIONS, "2026-11-19.jsonl");
  // Made here and removed after, as other tests expect the made-up data without them.
  const made = [UNITS, OBSERVATIONS].filter((d) => !existsSync(d));
  try {
    await checksNow(null);
    reads.mockClear();
    await checksNow(null);
    expect(reads).toHaveBeenCalledTimes(0);
    // The watcher's sync: today's units written, under the lock.
    await locked(() => {
      mkdirSync(UNITS, { recursive: true });
      writeFileSync(join(UNITS, "2026-11-19.jsonl"), "");
      return Promise.resolve();
    });
    await checksNow(null);
    expect(reads).toHaveBeenCalledTimes(0);
    // A night's run: an observation written.
    mkdirSync(OBSERVATIONS, { recursive: true });
    writeFileSync(day, "");
    await checksNow(null);
    expect(reads).toHaveBeenCalledTimes(1);
    // What agents hold keys on its stamp alone: the facts are read only when the list is.
    const held = (stamp: string) => ({
      read: () => anchored("obs_000000000001"),
      stamp,
    });
    await checksNow(held("1"));
    expect(reads).toHaveBeenCalledTimes(2);
    await checksNow(held("1"));
    expect(reads).toHaveBeenCalledTimes(2);
    await checksNow(held("2"));
    expect(reads).toHaveBeenCalledTimes(3);
    setSystemTime(new Date(clock().getTime() + DAY));
    await checksNow(held("2"));
    expect(reads).toHaveBeenCalledTimes(4);
  } finally {
    setSystemTime();
    reads.mockRestore();
    rmSync(day, { force: true });
    rmSync(join(UNITS, "2026-11-19.jsonl"), { force: true });
    for (const d of made) {
      rmSync(d, { force: true, recursive: true });
    }
  }
});

// Audit of 19 Nov 2026: 12 of 14 open "Work on it?" cards were for matters long over; the next step was drafted before
// the answer came from outside the matter. A direction that looks over (no next step), or not checked against what
// happened since (`isDirectionDue`), is not offered.
test("a matter whose direction looks over, or is not checked against what happened since, is not offered (stale-2-wait-answered-in-other-matter)", () => {
  const at = "2026-11-17T02:00:00Z";
  const matter = {
    goal: { at, by: "life" as const, text: "The deposit is back." },
    id: "matter_000000000008",
    lone: false,
    name: "Flat deposit",
    newestOpenStep: {
      at,
      day: "2026-11-17",
      kind: "waiting_on_someone" as const,
      quote: "waiting for the landlord",
      ref: "obs_000000000081",
      text: "waiting for the landlord",
    },
    nextStep: {
      at,
      by: "life" as const,
      kind: "do" as const,
      text: "Ask the landlord for the deposit",
    },
    open: true,
    owedTo: [],
    projects: [] as string[],
    status: "moving" as const,
    steps: [
      {
        at: "2026-11-17T09:00:00.000Z",
        day: "2026-11-17",
        quote: "waiting for the landlord",
        ref: "obs_000000000081",
      },
    ],
    waitingOn: [],
    with: [],
  };
  const offered = (
    m: typeof matter | Omit<typeof matter, "nextStep">,
    due = false
  ) =>
    checksOf(inputs([], { isDirectionDue: () => due, matters: [m] })).filter(
      (c) => c.group === "new matter"
    ).length;
  expect(offered(matter)).toBe(1);
  // An outside record since the draft: the next step waits for its redraft.
  expect(offered(matter, true)).toBe(0);
  // The draft said it looks over (`directionsOf` leaves no next step).
  const { nextStep: _gone, ...over } = matter;
  expect(offered(over)).toBe(0);
});

test("a decision whose draft goes to a guessed person carries that guess; a matter finds the checks riding on it", () => {
  const o = line();
  const m = {
    id: "matter_cccccccccccc",
    lone: false,
    name: "Boiler repair",
    open: true,
    owedTo: [],
    projects: [] as string[],
    status: "moving" as const,
    steps: stepsOf(o.id),
    waitingOn: [],
    with: [],
  };
  const sent = {
    ...decision("dec_00000000000c", "2026-11-20T09:00:00.000Z"),
    draft: {
      channel: "whatsapp",
      chat: "33600000001@s.whatsapp.net",
      text: "Friday?",
      to: "Kit",
    },
  };
  const base = inputs([about(REF)], {
    decisions: [sent],
    inferred: [ID],
    matters: [m],
  });
  const list = checksOf({
    ...base,
    people: {
      ...base.people,
      resolve: (s: string) => (s === "+33600000001" ? REF : null),
    },
  });
  const [asked, guess] = list;
  expect(asked?.confirm.map((c) => c.ref)).toEqual([REF]);
  expect(guess?.confirm).toEqual([]);
  // No handle behind the stored chat: nothing to confirm.
  expect(
    checksOf({
      ...base,
      decisions: [{ ...sent, draft: { ...sent.draft, chat: "room-1" } }],
    })[0]?.confirm
  ).toEqual([]);
  // A check on a matter by its subject, or by what rides on it.
  const onMatter = checksOf({
    ...base,
    decisions: [decision("dec_00000000000d", "2026-11-20T09:00:00.000Z", o.id)],
  });
  expect(checksOnMatterOf(onMatter, m.id).map((c) => c.ref)).toEqual([
    "dec_00000000000d",
  ]);
  expect(checksOnMatterOf(onMatter, "matter_zzzzzzzzzzzz")).toEqual([]);
});

test("a guessed person's check riding on an open matter through its saved line is found by that matter alone", () => {
  const o = about(REF);
  const m = {
    id: "matter_dddddddddddd",
    lone: false,
    name: "Boiler repair",
    open: true,
    owedTo: [],
    projects: [] as string[],
    status: "moving" as const,
    steps: stepsOf(o.id),
    waitingOn: [],
    with: [],
  };
  const [guess] = checksOf(inputs([o], { inferred: [ID], matters: [m] }));
  expect(guess?.matter).toBeNull();
  expect(guess?.ridesOn.matterIds).toEqual([m.id]);
  expect(checksOnMatterOf([guess as Check], m.id)).toEqual([guess as Check]);
});

test("only the open endings' and the new matters' steps are read for their sentences: a closed ending's or an old matter's never", () => {
  const link = { later: "obs_b", quote: "it is done" };
  const matter = (day: string, ref: string) => ({ steps: [{ day, ref }] });
  const shown = shownStepsOf({
    answered: new Set(["obs_closed"]),
    doubted: new Set(),
    endings: new Map([
      ["obs_open", link],
      ["obs_closed", { later: "obs_c", quote: "x" }],
    ]),
    matters: [matter("2026-11-17", "obs_new"), matter("2026-10-01", "obs_old")],
    today: "2026-11-18",
  });
  expect([...shown].sort()).toEqual(["obs_b", "obs_new", "obs_open"]);
});

test("a desk agent's decision names the agent that asked it; every other check names none", () => {
  const asked = {
    ...decision("dec_00000000000e", "2026-11-20T09:00:00.000Z"),
    agent: "agt_0123456789ab",
    asker: "desk",
  };
  const [check] = checksOf(inputs([], { decisions: [asked] }));
  expect(check?.agent).toBe("agt_0123456789ab");
});
