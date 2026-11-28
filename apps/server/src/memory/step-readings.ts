import { join } from "node:path";
import { z } from "zod";
import { appendJsonl, readAppended } from "../core/files";
import { Level } from "../core/names";
import { isoDateTime, MadeBy } from "../records/fields";
import { HandledBy, StepMoney } from "./check-urgency";
import { instructionsOn, whatToAskNow } from "./instructions";
import type { MatterStepNow, MatterView } from "./matter-read";
import { MEMORY } from "./memory-files";
import {
  begin,
  checkedEntries,
  chunks,
  inBatches,
  inputsOf,
  readsOf,
} from "./run";
import type { People } from "./who";
import { OWED_BY_HIM, type StepReadings } from "./your-move";

// Step readings (docs/glossary.md): the memory's fast tier reads each open step he owes, with his `what-to-ask` words in
// force on it, and gives who does it (`handledBy`), how soon it needs him (`urgency`), its money and the instruction
// that says not to ask it (`by`). Readings, not a verdict: `askOfStep` decides. One line per step version in
// memory/step-readings.jsonl (this file is its only writer), keyed by `stepInputsOf`; read again only when the step or
// his words on it change. No date reaches the call: due days are code's.

const PROMPT = "memory-step-readings.v1";
/** The readings: one line per step version, append-only, the newest per step version winning. */
export const STEP_READINGS = join(MEMORY, "step-readings.jsonl");
/** How many steps one call reads, and the most calls a night (the newest steps first; the rest stay due). */
const STEPS_A_CALL = 25;
const CALLS_A_NIGHT = 60;

const StepReadingLine = z
  .object({
    at: isoDateTime,
    by: z.string().nullable(),
    /** The digest of his words it was read with (`guidanceOf`): changed, the step is read again. */
    guidance: z.string(),
    handledBy: HandledBy,
    /** The step version it reads (`stepInputsOf`). */
    inputs: z.string(),
    madeBy: MadeBy,
    money: StepMoney,
    reason: z.string(),
    schemaVersion: z.literal(1),
    step: z.string(),
    urgency: Level,
  })
  .strict();
type StepReadingLine = z.infer<typeof StepReadingLine>;

const Read = StepReadingLine.pick({
  by: true,
  handledBy: true,
  money: true,
  urgency: true,
})
  .extend({
    by: z.string().nullable().default(null),
    reason: z.string().min(1).max(300),
    step: z.string(),
  })
  .strict();

type StepMatter = Pick<
  MatterView,
  "areas" | "goal" | "id" | "name" | "nextStep" | "owedTo" | "projects"
>;
type Step = Pick<
  MatterStepNow,
  "at" | "kind" | "ref" | "text" | "when" | "with"
>;

/** A step version: its matter, words, kind, person, whom he owes and due day, with the prompt. Pure. */
const stepInputsOf = (v: Pick<StepMatter, "id" | "owedTo">, s: Step) =>
  inputsOf(PROMPT, {
    due: s.when ?? null,
    kind: s.kind,
    matter: v.id,
    owedTo: v.owedTo,
    text: s.text,
    with: s.with ?? null,
  });

type Words = ReturnType<typeof whatToAskNow>;

/** Of his `what-to-ask` words in force (`whatToAskNow`), those on step `s` of matter `v`, as a call shows them. Pure. */
const guidanceOf = (
  words: Words,
  v: Pick<StepMatter, "id" | "owedTo" | "projects">,
  s: Step
) =>
  instructionsOn(words, {
    matter: v.id,
    people: [...(s.with ? [s.with] : []), ...v.owedTo],
    projects: v.projects,
  }).map((i) => ({ id: i.id, text: i.text }));

/** Every reading, by its step version (`stepInputsOf`), the newest winning. */
const readReadingLines = () =>
  readAppended<StepReadingLine, Map<string, StepReadingLine>>(
    STEP_READINGS,
    StepReadingLine,
    (last) => new Map(last),
    (all, row) => {
      all.set(row.inputs, row);
    }
  );

/**
 * The step readings as the cards and the hand-out read them now (`StepReadings`), over `matters` by id, his words read
 * once. A reading made under other words than his now reads `owner`: replacing them un-hides at once.
 */
export function readStepReadings(
  matters: readonly Pick<StepMatter, "id" | "owedTo" | "projects">[]
): Omit<StepReadings, "today"> {
  const readings = readReadingLines();
  const words = whatToAskNow();
  const byId = new Map(matters.map((v) => [v.id, v]));
  return {
    stepReadingOf: (matter, s) => {
      const v = byId.get(matter);
      const r = v && readings.get(stepInputsOf(v, s));
      return r && r.guidance !== inputsOf(PROMPT, guidanceOf(words, v, s))
        ? { ...r, handledBy: "owner" }
        : r;
    },
    whatToAskOf: (matter, s) => {
      const v = byId.get(matter);
      return new Set(v ? guidanceOf(words, v, s).map((g) => g.id) : []);
    },
  };
}

/** The open steps he owes on `open` with no reading of their version and his words now, newest first, each once. */
function dueStepsOf(open: readonly (StepMatter & { openSteps: Step[] })[]) {
  const readings = readReadingLines();
  const words = whatToAskNow();
  const seen = new Set<string>();
  return open
    .flatMap((v) =>
      v.openSteps.flatMap((s) => {
        const inputs = stepInputsOf(v, s);
        const shown = guidanceOf(words, v, s);
        const guidance = inputsOf(PROMPT, shown);
        const isDue =
          OWED_BY_HIM.includes(s.kind) &&
          !seen.has(inputs) &&
          readings.get(inputs)?.guidance !== guidance;
        seen.add(inputs);
        return isDue ? [{ guidance, inputs, s, shown, v }] : [];
      })
    )
    .toSorted((a, b) => b.s.at.localeCompare(a.s.at));
}

/**
 * Reads the steps due (`dueStepsOf`) of the open matters `open`, grouped by his words on them, `STEPS_A_CALL` a call,
 * at most `CALLS_A_NIGHT` calls, the newest steps first: one line per step the reply reads, appended as its call ends
 * (one it leaves out, or a failed call, is read next night). A `by` not among the call's words is dropped.
 */
export async function stepReadings(
  people: Pick<People, "nameOf">,
  open: readonly (StepMatter & { openSteps: Step[] })[]
) {
  const calls = [...Map.groupBy(dueStepsOf(open), (d) => d.guidance).values()]
    .flatMap((group) => chunks(group, STEPS_A_CALL))
    .toSorted((a, b) => (b[0]?.s.at ?? "").localeCompare(a[0]?.s.at ?? ""))
    .slice(0, CALLS_A_NIGHT);
  if (calls.length === 0) {
    return { read: 0 };
  }
  const step = await begin("step-readings", "fast", { prompt: PROMPT });
  let read = 0;
  await inBatches(calls, step, async (batch, dir) => {
    await step.attempt(async () => {
      const shown = batch[0]?.shown ?? [];
      const reply = await step.ask({
        dir: join(dir, "call"),
        input: {
          guidance: shown,
          items: batch.map(({ s, v }, i) => ({
            areas: v.areas,
            id: `s${i + 1}`,
            kind: s.kind,
            matter: v.name,
            owedTo: v.owedTo.map(people.nameOf),
            step: s.text,
            ...(v.goal ? { goal: v.goal.text } : {}),
            ...(v.nextStep ? { next: v.nextStep.text } : {}),
            ...(v.projects[0] ? { project: v.projects[0] } : {}),
            ...(s.with ? { with: people.nameOf(s.with) } : {}),
          })),
        },
        prompt: PROMPT,
        reads: readsOf(
          batch.map(({ s }) => ({ source: "memory", unit: s.ref }))
        ),
      });
      const list = (reply as { readings?: unknown } | null)?.readings;
      const byCallId = new Map(batch.map((d, i) => [`s${i + 1}`, d]));
      const { entries } = checkedEntries(
        Array.isArray(list) ? list : [],
        Read,
        (e) => e.step,
        (id) => byCallId.has(id)
      );
      const ids = new Set(shown.map((g) => g.id));
      const at = step.now.toISOString();
      const madeBy = step.madeBy(PROMPT);
      appendJsonl(
        STEP_READINGS,
        StepReadingLine,
        entries.flatMap(({ by, step: id, ...r }) => {
          const d = byCallId.get(id);
          return d
            ? [
                {
                  ...r,
                  at,
                  by: by && ids.has(by) ? by : null,
                  guidance: d.guidance,
                  inputs: d.inputs,
                  madeBy,
                  schemaVersion: 1 as const,
                  step: d.s.ref,
                },
              ]
            : [];
        })
      );
      read += entries.length;
    });
  });
  return step.end({ read });
}
