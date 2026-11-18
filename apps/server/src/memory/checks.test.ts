import { expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock, DAY } from "../core/clock";
import type { Correction } from "../records/observation";
import type { NamingQueueItem } from "../sources/lifelog-voices";
import {
  type Check,
  type CheckInputs,
  checksNow,
  checksOf,
  checksText,
  pushIdOf,
} from "./checks";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matters from "./matters";
import { OBSERVATIONS, UNITS } from "./memory-files";
import { locked } from "./memory-lock";
import { guessTestOf } from "./who";

type Input = Partial<Omit<CheckInputs, "people">> & {
  corrections?: Correction[];
  inferred?: string[];
  cards?: { card: string; people: string[] }[];
};

let n = 0;
const line = (over: Partial<CheckInputs["lines"][number]> = {}) => {
  n += 1;
  return {
    about: undefined,
    confidence: 0.9,
    date: "2026-10-01",
    id: `obs_${String(n).padStart(12, "0")}`,
    quote: "I'll bring it Friday",
    source: { channel: "whatsapp" as const },
    subjects: [],
    text: "He brings it Friday.",
    unit: "unit_000000000001",
    ...over,
  };
};
const about = (ref: string, over = {}) => line({ subjects: [ref], ...over });

const ASKED_UNTIL_22_NOV =
  /Next step: Book the plumber\. Asked until .*22 Nov\.$/;

/** A matter's steps, made up: each on 1 Oct with a quote. */
const stepsOf = (...refs: string[]) =>
  refs.map((ref) => ({ day: "2026-10-01", quote: "it", ref }));

function inputs(lines: CheckInputs["lines"], over: Input = {}): CheckInputs {
  const isGuess = guessTestOf(over.corrections ?? []);
  return {
    anchored: new Set(),
    answered: new Set(),
    decisions: [],
    dismissed: [],
    doubted: new Set(),
    endings: new Map(),
    kept: new Set(lines.map((l) => l.id)),
    lines,
    matters: [],
    paged: new Set(),
    today: "2026-11-18",
    unresolved: [],
    voices: [],
    where: new Map(),
    ...over,
    people: {
      ambiguousCards: over.cards ?? [],
      contacts: [],
      inferred: (over.inferred ?? []).map((id) => ({
        at: "2026-10-02T10:00:00.000Z",
        confidence: 0.7,
        evidence: [{ quote: `${id} said hello`, unit: "unit_000000000001" }],
        id,
        name: `Kit ${id}`,
        namesAndHandles: ["+33600000001"],
        relation: "the plumber",
      })),
      isGuess,
      nameOf: (r: string) => (r === "person:dana" ? "Dana" : r),
      names: new Map(),
      refOf: (r: string) => r,
      resolve: (s: string) => (s === DANA_ID ? "person:dana" : null),
    },
  };
}

const DANA_ID = "00000000-0000-4000-8000-000000000001";
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
  expect(check?.question).toStartWith("Life thinks this is ");
  expect(check?.question).toContain("the plumber");
  // Life's guess is its recommendation, listed first; on silence nothing is taken; its kind gives the title and context.
  expect(check).toMatchObject({
    asker: "life",
    context: "Life uses its guess until you say.",
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
  expect(printed).toContain(`1. [guessed person] ${REF}: Life thinks`);
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
          status: "moving" as const,
          steps: stepsOf(a.id),
          told: [],
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
  const kinds = checksOf(
    inputs(lines, {
      cards: [{ card: "person:con_card", people: ["person:a", "person:b"] }],
      inferred: [ID],
      unresolved: names.map((x, i) => ({
        nameAsWritten: x,
        observation: (nameLines[i] as { id: string }).id,
      })),
    })
  ).map((x) => x.ref);
  expect(kinds).toHaveLength(32);
  expect(kinds).toContain(REF);
  expect(kinds).toContain("person:con_card");
  expect(kinds.filter((r) => r.startsWith("name:"))).toHaveLength(30);
});

test("an ending rides on its open matter and goes with his answer", () => {
  const o = line({ text: "Send the quote." });
  const matter = {
    id: "matter_aaaaaaaaaaaa",
    lone: false,
    name: "Send the quote",
    open: true,
    owedTo: [],
    status: "moving" as const,
    steps: stepsOf(o.id),
    told: [],
    waitingOn: [],
    with: [],
  };
  const base = inputs([o], {
    endings: new Map([[o.id, { later: "ep_000000000001", quote: "Sent it." }]]),
    kept: new Set(),
    matters: [matter],
  });
  const [ending] = checksOf(base);
  expect(ending).toMatchObject({
    evidence: { quote: "Sent it." },
    kind: "ending",
    matter: { id: "matter_aaaaaaaaaaaa", name: "Send the quote" },
    ref: o.id,
    ridesOn: { matters: 1, observations: 0 },
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
    status: "moving" as const,
    steps: stepsOf(o.id),
    told: [],
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
    namedPersonId: null,
    personId: null,
    voices: [{ conversationId: "c1", jobId: "job-1", speakerLabel: "A" }],
    words: 40,
    ...over,
  }) satisfies NamingQueueItem;

test("every voice in lifelog's queue is a card of the one inbox, with its clips and the people it may be", () => {
  const items = Array.from({ length: 60 }, (_, i) => voice(`v${i}`));
  items[0] = voice("v0", { kind: "known_person", personId: DANA_ID });
  items[1] = voice("v1", { name: "Kofi" });
  // One he called several people is not asked in v1: one answer would give all its turns to one person.
  const cards = checksOf(
    inputs([], { voices: [...items, voice("v60", { kind: "several" })] })
  ).filter((c) => c.group === "voice");
  expect(cards).toHaveLength(60);
  const byRef = (r: string) => cards.find((c) => c.ref === r);
  expect(byRef("voice:v0")?.question).toBe("Is this voice Dana?");
  expect(byRef("voice:v1")?.question).toBe(
    'Who is this voice? It was called "Kofi".'
  );
  expect(byRef("voice:v1")?.about).toEqual(["Kofi"]);
  expect(byRef("voice:v2")?.question).toBe("Who is this voice?");
  expect(byRef("voice:v2")?.likelyPeople).toEqual([
    { name: "Dana", person: "person:dana" },
  ]);
  expect(byRef("voice:v2")?.clips[0]?.audio).toEqual({
    end: 4,
    jobId: "job-1",
    start: 1,
  });
  expect(byRef("voice:v2")?.evidence?.quote).toBe("See you Friday");
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

test("a new matter an agent could move asks 'Work on it?' for 7 days from its first step, with no deadline, until he answers it", () => {
  const steps = [
    {
      day: "2026-11-16",
      quote: "the boiler is leaking",
      ref: "obs_000000000071",
    },
    { day: "2026-11-17", quote: "call the plumber", ref: "unit_000000000072" },
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
    nextStep: {
      at: "2026-11-17T02:00:00Z",
      by: "life" as const,
      kind: "do" as const,
      text: "Book the plumber",
    },
    open: true,
    owedTo: [],
    status: "moving" as const,
    steps,
    told: [],
    waitingOn: [],
    with: [],
  };
  const base = inputs([], { matters: [matter] });
  expect(checksOf(base)).toEqual([
    {
      about: [],
      asker: "life",
      at: null,
      clips: [],
      context: expect.stringMatching(ASKED_UNTIL_22_NOV),
      deadline: null,
      draft: null,
      evidence: {
        from: expect.stringContaining("16 Nov"),
        quote: "the boiler is leaking",
      },
      group: "new matter",
      kind: "new matter",
      likelyPeople: [],
      links: [],
      matter: { id: matter.id, name: "Boiler service" },
      notSent: null,
      // 19 Nov 2026 (review A, B5): it held a sentence where every other kind holds an option id.
      onSilence: null,
      options: [
        expect.objectContaining({ id: "start" }),
        expect.objectContaining({ id: "edit-goal" }),
        expect.objectContaining({ id: "dismiss" }),
      ],
      question: "Goal: The boiler is serviced. Work on it?",
      ref: matter.id,
      ridesOn: { matters: 1, observations: 0, pages: 0 },
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
  expect(checksOf({ ...base, matters: [edited] })[0]?.question).toBe(
    "Goal: Serviced and the leak fixed. Work on it?"
  );
  // Its last day is the 7th from its first step; it never outranks an agent's decision.
  expect(checksOf({ ...base, today: "2026-11-22" })).toHaveLength(1);
  const none = (over: Partial<CheckInputs>) => checksOf({ ...base, ...over });
  const wait = {
    ...matter.nextStep,
    kind: "wait_event" as const,
    waitsOn: "the plumber",
  };
  for (const list of [
    none({ today: "2026-11-23" }),
    none({ anchored: null }),
    none({ anchored: new Set(["unit_000000000072"]) }),
    none({ dismissed: [["obs_000000000071"]] }),
    none({ matters: [{ ...matter, goal: undefined }] }),
    none({ matters: [{ ...matter, nextStep: wait }] }),
    none({ matters: [{ ...matter, lone: true }] }),
    none({ matters: [{ ...matter, open: false, status: "done" as const }] }),
    none({ matters: [{ ...matter, status: "dormant" as const }] }),
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
      { day: "2026-11-18", quote: "plumber booked", ref: "obs_000000000073" },
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
test("the inbox is read again only when what it reads changed: not a unit sync; a run's lines, an agent anchored, a new day", async () => {
  const reads = spyOn(matters, "readMatterRecords");
  const day = join(OBSERVATIONS, "2026-11-19.jsonl");
  try {
    await checksNow(null);
    reads.mockClear();
    await checksNow(null);
    expect(reads).toHaveBeenCalledTimes(0);
    // The watcher's sync: today's units written, under the lock.
    await locked(async () => {
      mkdirSync(UNITS, { recursive: true });
      writeFileSync(join(UNITS, "2026-11-19.jsonl"), "");
    });
    await checksNow(null);
    expect(reads).toHaveBeenCalledTimes(0);
    // A night's run: an observation written.
    mkdirSync(OBSERVATIONS, { recursive: true });
    writeFileSync(day, "");
    await checksNow(null);
    expect(reads).toHaveBeenCalledTimes(1);
    await checksNow(new Set(["obs_000000000001"]));
    expect(reads).toHaveBeenCalledTimes(2);
    setSystemTime(new Date(clock().getTime() + DAY));
    await checksNow(new Set(["obs_000000000001"]));
    expect(reads).toHaveBeenCalledTimes(3);
  } finally {
    setSystemTime();
    reads.mockRestore();
    rmSync(day, { force: true });
    rmSync(join(UNITS, "2026-11-19.jsonl"), { force: true });
  }
});
