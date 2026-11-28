import { afterEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as models from "../models/llm";
import { askOfStep } from "./check-urgency";
import { INSTRUCTIONS, recordInstruction } from "./instructions";
import type { MatterView } from "./matter-read";
import { readStepAsk, STEP_READINGS, stepReadings } from "./step-readings";

// Step readings on a made-up model, made-up shop and bills (card sort, 28 Nov 2026): the stock-orders words hide the
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
const matter = (id: string, s: ReturnType<typeof step>) =>
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

/** A made-up model: cites `by` on the invoice, an id never shown on the rent. */
const fakeModel = () =>
  spyOn(models, "askOnce").mockImplementation((async (o: {
    input: {
      guidance: { id: string }[];
      items: { id: string; step: string }[];
    };
  }) => ({
    readings: o.input.items.map((i) => ({
      by: i.step.includes("flour")
        ? (o.input.guidance[0]?.id ?? null)
        : "ins_ffffffffffff",
      goodMoment: false,
      handledBy: "owner",
      money: "some",
      reason: "made up",
      step: i.id,
      urgency: "normal",
    })),
  })) as never);

const hiddenOf = (s: ReturnType<typeof step>, id: string) => {
  const ask = readStepAsk(OPEN);
  return askOfStep(
    ask.stepReadingsOf?.(id, s),
    { first: s.day, isPromiseToPerson: false },
    ask.whatToAskOf?.(id, s) ?? new Set(),
    "2026-11-28"
  ).isHidden;
};

test("card sort: stock-orders words hide the supplier invoice they cite, never the rent; replaced, the invoice is asked at once and read again", async () => {
  const ask = fakeModel();
  try {
    const words = recordInstruction({
      effect: "what-to-ask",
      said: "Stock orders for the shop are the shop manager's, don't ask me",
      scope: "all",
      text: "Stock orders for the shop are the shop manager's: never ask.",
    });
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
    recordInstruction({
      effect: "what-to-ask",
      replaces: words.id,
      said: "Ask me about every bill",
      scope: "all",
      text: "Ask about every bill.",
    });
    expect(hiddenOf(INVOICE, "matter_1")).toBe(false);
    await stepReadings(people, OPEN);
    expect(ask).toHaveBeenCalledTimes(2);
  } finally {
    ask.mockRestore();
  }
});
