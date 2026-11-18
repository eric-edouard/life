import { expect, test } from "bun:test";
import type { Correction } from "../records/observation";
import { type Check, type CheckInputs, checksOf, checksText } from "./checks";
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

function inputs(lines: CheckInputs["lines"], over: Input = {}): CheckInputs {
  const isGuess = guessTestOf(over.corrections ?? []);
  return {
    answered: new Set(),
    decisions: [],
    doubted: new Set(),
    endings: new Map(),
    isDeskOn: false,
    kept: new Set(lines.map((l) => l.id)),
    lines,
    matters: [],
    now: "2026-11-18T09:00:00.000Z",
    paged: new Set(),
    startsAnswered: new Set(),
    unresolved: [],
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
      names: new Map(),
      refOf: (r: string) => r,
      resolve: () => null,
    },
  };
}

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
  // Life's guess is its recommendation; on silence nothing is taken.
  expect(check).toMatchObject({
    asker: "life",
    onSilence: null,
    recommended: ["this-is"],
    why: null,
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
          id: "matter_000000000001",
          lone: false,
          name: "An errand",
          open: true,
          owedTo: [],
          steps: [{ ref: a.id }],
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
    id: "matter_000000000001",
    lone: false,
    name: "An errand",
    open: true,
    owedTo: [],
    steps: [{ ref: o.id }],
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
  recommended: ["yes"],
  schemaVersion: 2 as const,
  state: "open" as const,
  ...(subject ? { subject } : {}),
  why: "It is due.",
});

test("open decisions come first, soonest deadline first; one on a step leaves with its matter, one on a project stays", () => {
  const o = line();
  const matter = (open: boolean) => ({
    id: "matter_000000000001",
    lone: false,
    name: "An errand",
    open,
    owedTo: [],
    steps: [{ ref: o.id }],
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
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Go ahead with dec_00000000000a?",
    recommended: ["yes"],
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

test("a new matter an agent could move asks 'work on it?' while the desk is on, until he answers it or a week passes", () => {
  const draft = { agentCanMove: true, at: "2026-11-15T02:00:00.000Z" };
  const matter = {
    goal: {
      by: "life" as const,
      draft,
      text: "The boiler is serviced",
    },
    id: "matter_000000000007",
    lone: false,
    name: "Boiler service",
    open: true,
    owedTo: [],
    steps: [{ ref: "obs_000000000071" }, { ref: "unit_000000000072" }],
    told: [],
    waitingOn: [],
    with: [],
  };
  const base = inputs([], { isDeskOn: true, matters: [matter] });
  expect(checksOf(base)).toEqual([
    {
      about: [],
      asker: "life",
      at: draft.at,
      context: null,
      deadline: "2026-11-22T02:00:00.000Z",
      evidence: null,
      group: "matter start",
      kind: "matter start",
      links: [],
      onSilence: null,
      options: expect.arrayContaining([
        expect.objectContaining({ id: "start" }),
        expect.objectContaining({ id: "edit-goal" }),
        expect.objectContaining({ id: "dismiss" }),
      ]),
      question:
        'Life found "Boiler service". Goal: The boiler is serviced. Work on it?',
      recommended: ["start"],
      ref: "start:obs_000000000071",
      ridesOn: { matters: 1, observations: 0, pages: 0 },
      subject: "obs_000000000071",
      why: "An agent could move it forward.",
    },
  ]);
  // His goal, once he edits it, is what it asks about.
  const edited = {
    ...matter,
    goal: {
      by: "owner" as const,
      draft,
      text: "Serviced and the leak fixed",
    },
  };
  expect(checksOf({ ...base, matters: [edited] })[0]?.question).toContain(
    "Goal: Serviced and the leak fixed."
  );
  const none = (over: Partial<CheckInputs>) => checksOf({ ...base, ...over });
  expect(none({ isDeskOn: false })).toEqual([]);
  expect(none({ now: "2026-11-22T02:00:00.000Z" })).toEqual([]);
  expect(none({ startsAnswered: new Set(["unit_000000000072"]) })).toEqual([]);
  expect(
    none({
      matters: [
        {
          ...matter,
          goal: { ...matter.goal, draft: { ...draft, agentCanMove: false } },
        },
      ],
    })
  ).toEqual([]);
  expect(none({ matters: [{ ...matter, open: false }] })).toEqual([]);
});
