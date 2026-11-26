import { afterEach, expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import type { MatterView } from "./matter-read";
import { matterSituationInputOf, matterSituations } from "./matter-situations";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matters from "./matters";
import { matterSituationPath } from "./memory-files";
import { inputsOf } from "./run";
import { readMatterSituationNow } from "./situation-parts";
import type { People } from "./who";

const S1 = "obs_aaaaaaaaaaaa";
const S2 = "obs_bbbbbbbbbbbb";
const TWO = "matter_test00000002";
const ONE = "matter_test00000001";

afterEach(async () => {
  await rm(matterSituationPath(TWO), { force: true });
  await rm(matterSituationPath(ONE), { force: true });
});

const step = (ref: string, day: string, text: string) => ({
  at: `${day}T09:00:00Z`,
  day,
  kind: "fact" as const,
  quote: "",
  ref,
  text,
});
const matter = (id: string, over: Partial<MatterView> = {}): MatterView =>
  ({
    id,
    name: "Kitchen quote",
    open: false,
    openSteps: [],
    owedTo: [],
    projects: [],
    status: "done",
    steps: [
      step(S1, "2026-11-12", "Ben sent a first quote."),
      step(S2, "2026-11-20", "Ben sent the second quote."),
    ],
    waitingOn: [],
    with: ["person:test-ben"],
    ...over,
  }) as unknown as MatterView;

test("a matter situation's digest holds its steps' ids and words, never its name, its people or the day", () => {
  const digest = (v: MatterView, today: string, nameOf = (r: string) => r) =>
    inputsOf("p", matterSituationInputOf(v, [], today, nameOf).digested);
  const before = digest(matter(TWO), "2026-11-21");
  expect(
    digest(matter(TWO, { name: "Renamed" }), "2026-12-30", () => "Benjamin")
  ).toBe(before);
  expect(
    digest(
      matter(TWO, {
        steps: [step(S1, "2026-11-12", "Ben sent a first quote.")],
      }),
      "2026-11-21"
    )
  ).not.toBe(before);
});

test("a night writes the situation of a matter of two steps, never one of a single step, and asks again only when its steps change", async () => {
  const models = await import("../models/llm");
  const book = [
    matter(TWO),
    matter(ONE, { steps: [step(S1, "2026-11-12", "One step.")] }),
  ];
  const bookOf = spyOn(matters, "matterBookAgain").mockReturnValue(book);
  const ask = spyOn(models, "askOnce").mockResolvedValue({
    parts: [
      { cites: [S1, S2], markdown: "Ben quoted twice, on 12 and 20 Nov." },
    ],
  } as never);
  const people = {
    nameOf: (r: string) => r,
    truth: { areas: [], me: { text: "" }, projects: [] },
  } as unknown as People;
  const records = { observations: [], refOf: (r: string) => r } as never;
  try {
    await matterSituations(people, { records, today: "2026-11-21" });
    await matterSituations(people, { records, today: "2026-11-22" });
    expect(ask).toHaveBeenCalledTimes(1);
    expect(readMatterSituationNow(TWO)).toEqual([
      { cites: [S1, S2], markdown: "Ben quoted twice, on 12 and 20 Nov." },
    ]);
    expect(readMatterSituationNow(ONE)).toEqual([]);
  } finally {
    bookOf.mockRestore();
    ask.mockRestore();
  }
});
