import { expect, test } from "bun:test";
import { urgencyOf } from "./check-urgency";
import { type CheckInputs, checksOf } from "./checks";
import { about, inputs, line, nameRow } from "./checks-test-inputs";
import { causeOf } from "./complaint-checks";
import type { Check } from "./life-checks";

// "Wrong…" on the checks: offered on Life's own cards, its cause, and a card his complaint is at work on. Made-up lines.

const ID = "inf_kit";
const REF = `person:${ID}`;
const DECISION = {
  asker: "planner",
  at: "2026-11-18T09:00:00.000Z",
  context: "",
  deadline: "2026-11-30T09:00:00.000Z",
  id: "dec_00000000000c",
  kind: "asked" as const,
  links: [],
  onSilence: null,
  options: [{ id: "yes", label: "Yes" }],
  question: "Go ahead?",
  schemaVersion: 3 as const,
  state: "open" as const,
  title: "It is due.",
};

test("“Wrong…” is on Life's own cards alone; its cause holds through a count, not another guess; his complaint at work on it makes the card stop blocking and go after what blocks", () => {
  const n = line();
  const guessed = about(REF);
  const of = (over: Partial<CheckInputs> = {}, lines = [n, guessed]) => ({
    ...inputs(lines, {
      decisions: [DECISION],
      inferred: [ID],
      unresolved: [nameRow("Dre", n.id)],
    }),
    ...over,
  });
  const list = checksOf(of());
  expect(list.map((c) => [c.ref, Boolean(c.misread)])).toEqual([
    ["dec_00000000000c", false],
    ["name:dre", true],
    [REF, true],
  ]);
  const name = list[1] as Check;
  expect(name.misread?.cause).toBe(causeOf(name, undefined, n.quote));
  // One more line riding on the name: the same cause, another card as shown.
  const more = checksOf(
    of({}, [n, guessed, line({ id: "obs_00000000dd01" })])
  ).find((c) => c.ref === "name:dre");
  expect(more?.misread?.cause).toBe(name.misread?.cause);
  expect(causeOf({ ...name, question: 'Who is "Dee"?' })).not.toBe(
    name.misread?.cause
  );
  // A new matter's goal he edits is another cause.
  expect(causeOf({ ...name, goal: "The watch is mended" })).not.toBe(
    causeOf({ ...name, goal: "Gran has her watch back" })
  );
  // An ending's cause is its link: another later step with the same words is another cause.
  expect(causeOf(name, "obs_00000000aa01")).not.toBe(
    causeOf(name, "obs_00000000aa02")
  );
  const fixing = new Map([
    [
      name.misread?.cause ?? "",
      { ask: "entry_00000000000f", line: null, since: "2026-11-20T09:00:00Z" },
    ],
  ]);
  const fixed = checksOf(of({ fixing }));
  expect(fixed.map((c) => c.ref)).toEqual([
    "dec_00000000000c",
    REF,
    "name:dre",
  ]);
  expect(fixed[2]?.beingFixed).toEqual(fixing.get(name.misread?.cause ?? ""));
  expect(urgencyOf(fixed[2] as Check)).toBe("improves");
});
