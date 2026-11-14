import { expect, test } from "bun:test";
import type { Correction } from "../records/observation";
import { type CheckInputs, checksOf } from "./checks";
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
    endings: new Map(),
    kept: new Set(lines.map((l) => l.id)),
    lines,
    matters: [],
    paged: new Set(),
    unresolved: [],
    where: new Map(),
    ...over,
    people: {
      ambiguousCards: over.cards ?? [],
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
    ridesOn: { matters: 0, observations: 3, summaries: 0 },
  });
  expect(check?.guess).toContain("the plumber");
  expect(check?.evidence?.quote).toBe(`${ID} said hello`);
});

test("his word, this-is or not-this-person, removes the check", () => {
  const lines = [about(REF)];
  const said = (kind: "this-is" | "not-this-person"): Correction => ({
    at: "2026-10-03T10:00:00.000Z",
    kind,
    nameOrHandle: "+33600000001",
    person: REF,
    schemaVersion: 1,
  });
  expect(checksOf(inputs(lines, { inferred: [ID] }))).toHaveLength(1);
  for (const kind of ["this-is", "not-this-person"] as const) {
    expect(
      checksOf(inputs(lines, { corrections: [said(kind)], inferred: [ID] }))
    ).toEqual([]);
  }
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

test("an ending rides on its open matter and goes with his answer; a line with no doubt of its own gives no fact check", () => {
  const o = line({ text: "Send the quote." });
  const matter = {
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
  expect(
    checksOf(inputs([about(REF)], { inferred: [ID] })).map((x) => x.kind)
  ).toEqual(["person"]);
});
