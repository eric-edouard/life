import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as models from "../models/llm";
import { askOfStep } from "./check-urgency";
import { INSTRUCTIONS, recordInstruction } from "./instructions";
import type { MatterView } from "./matter-read";
import { readStepReadings, STEP_READINGS, stepReadings } from "./step-readings";

// Step readings on a made-up model, made-up shops and bills (card sort, 28 Nov 2026): the stock-orders words hide the
// supplier invoice they are cited for, never the rent; a `by` not shown is dropped; replacing the words un-hides at once.

afterEach(() => {
  rmSync(STEP_READINGS, { force: true });
  rmSync(INSTRUCTIONS, { force: true });
});

const step = (n: number, text: string) => ({
  at: `2026-11-2${n}T09:00:00.000Z`,
  day: `2026-11-2${n}`,
  kind: "to_do" as const,
  quote: text,
  ref: `obs_00000000000${n}`,
  text,
});
const INVOICE = step(1, "Pay the flour supplier's invoice");
const RENT = step(2, "Pay the shop's rent");
const REFACTOR = step(3, "Refactor the till export");
type Step = ReturnType<typeof step>;
const matter = (id: string, s: Step) =>
  ({
    areas: [],
    id,
    name: s.text,
    openSteps: [s],
    owedTo: [],
    projects: [],
  }) as unknown as MatterView;
const OPEN = [matter("matter_1", INVOICE), matter("matter_2", RENT)];
const people = { nameOf: (r: string) => r };

/** What the made-up model cites: the first words shown on the invoice, an id never shown on the rent. */
const citedOf = (text: string, guidance: { id: string }[]) => {
  if (text.includes("flour")) {
    return guidance[0]?.id ?? null;
  }
  return text.includes("rent") ? "ins_ffffffffffff" : null;
};

/** A made-up model: cites `by` on the invoice, an id never shown on the rent; reads a refactor as his work elsewhere. */
const fakeModel = () =>
  spyOn(models, "askOnce").mockImplementation((async (o: {
    input: {
      guidance: { id: string }[];
      items: { id: string; step: string }[];
    };
  }) => ({
    readings: o.input.items.map((i) => ({
      by: citedOf(i.step, o.input.guidance),
      handledBy: i.step.includes("Refactor") ? "owner_elsewhere" : "owner",
      money: i.step.includes("Refactor") ? "none" : "some",
      reason: "made up",
      step: i.id,
      urgency: "normal",
    })),
  })) as never);

const hiddenOf = (s: Step, id: string, open = OPEN) => {
  const r = readStepReadings(open);
  return askOfStep(
    r.stepReadingOf?.(id, s),
    { first: s.day, isPromiseToPerson: false },
    r.whatToAskOf?.(id, s) ?? new Set(),
    "2026-11-28"
  ).isMoveHidden;
};

const words = (text: string, scope = "all", replaces?: string) =>
  recordInstruction({
    effect: "what-to-ask",
    said: text,
    scope,
    text,
    ...(replaces ? { replaces } : {}),
  });

test("card sort: stock-orders words hide the supplier invoice they cite, never the rent; replaced, the invoice is asked at once and read again", async () => {
  const ask = fakeModel();
  try {
    const stock = words(
      "Stock orders for the shop are the shop manager's: never ask."
    );
    expect((await stepReadings(people, OPEN)).read).toBe(2);
    expect(ask).toHaveBeenCalledTimes(1);
    // No date reaches the call.
    expect(JSON.stringify(ask.mock.calls[0]?.[0]?.input)).not.toContain("2026");
    expect(hiddenOf(INVOICE, "matter_1")).toBe(true);
    // A `by` the call was not shown is dropped: money protects the rent.
    expect(hiddenOf(RENT, "matter_2")).toBe(false);
    // Read once: the same steps and words are not read again.
    await stepReadings(people, OPEN);
    expect(ask).toHaveBeenCalledTimes(1);
    words("Ask about every bill.", "all", stock.id);
    expect(hiddenOf(INVOICE, "matter_1")).toBe(false);
    await stepReadings(people, OPEN);
    expect(ask).toHaveBeenCalledTimes(2);
  } finally {
    ask.mockRestore();
  }
});

test("card sort: a step read as his work elsewhere is asked again as soon as his words change, before the night reads it again", async () => {
  const ask = fakeModel();
  const open = [matter("matter_3", REFACTOR)];
  try {
    const code = words("Don't ask me about code work.");
    await stepReadings(people, open);
    expect(hiddenOf(REFACTOR, "matter_3", open)).toBe(true);
    words("Ask me about everything.", "all", code.id);
    expect(hiddenOf(REFACTOR, "matter_3", open)).toBe(false);
  } finally {
    ask.mockRestore();
  }
});

test("card sort: the same step words in two matters get their own readings, each with the words on its matter", async () => {
  const ask = fakeModel();
  const twice = [matter("matter_4", INVOICE), matter("matter_5", INVOICE)];
  try {
    words("Stock orders for this shop are its manager's.", "matter:matter_4");
    expect((await stepReadings(people, twice)).read).toBe(2);
    // One call per set of words: the matter's own, and none.
    expect(ask).toHaveBeenCalledTimes(2);
    expect(hiddenOf(INVOICE, "matter_4", twice)).toBe(true);
    expect(hiddenOf(INVOICE, "matter_5", twice)).toBe(false);
  } finally {
    ask.mockRestore();
  }
});
