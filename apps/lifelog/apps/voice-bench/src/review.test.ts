import { expect, test } from "bun:test";
import { reviewOf } from "./report";

const turn = (id: string, speakerLabel: string, personId?: string) => ({
  durationSeconds: Number(id.slice(1)),
  id,
  jobId: "job",
  speakerLabel,
  truth: personId ? ({ kind: "person", personId } as const) : undefined,
});
// Three models, each with its first guess per turn.
const models = (...firsts: Record<string, string>[]) =>
  firsts.map((byTurn) => ({
    turns: Object.fromEntries(
      Object.entries(byTurn).map(([id, best]) => [id, { best }])
    ),
  }));

test("the review offers voices, the likely wrong names first, names closest first", () => {
  const review = reviewOf(
    [
      // He said Ada; the models hear Bo on two turns and Ada on the third.
      turn("t2", "speaker_0", "ada"),
      turn("t9", "speaker_0", "ada"),
      turn("t5", "speaker_0", "ada"),
      // Never answered; the models hear Cy.
      turn("t4", "speaker_1"),
    ],
    models(
      { t2: "bo", t4: "cy", t5: "ada", t9: "bo" },
      { t2: "bo", t4: "cy", t5: "ada", t9: "bo" },
      { t2: "dee", t4: "cy", t5: "ada", t9: "bo" }
    ),
    new Map([["t7", { at: "", id: "t7", kind: "skipped" }]])
  );
  expect(review).toEqual([
    {
      // Bo on 5 of the card's 6 first guesses; his own answer stays offered.
      candidates: [
        { personId: "bo", share: 0.833 },
        { personId: "dee", share: 0.167 },
        { personId: "ada", share: 0 },
      ],
      clips: ["t9", "t2"],
      reason: "named-sounds-other",
      turns: ["t9", "t2"],
    },
    {
      candidates: [{ personId: "cy", share: 1 }],
      clips: ["t4"],
      reason: "confirm",
      turns: ["t4"],
    },
  ]);
});
