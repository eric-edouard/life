import { join } from "node:path";
import { z } from "zod";
import { appendJsonl } from "../core/files";
import { newestWithin, packed } from "../core/lists";
import {
  isNextStepOrOver,
  MatterDirectionBatch,
  MatterDirectionFields,
  ONE_OF,
} from "../records/matter";
import { type Observation, ObservationId } from "../records/observation";
import { type Evidence, readEvidence } from "./matter-evidence";
import {
  directionDueOf,
  laterShownOf,
  type MatterView,
  matterPeopleOf,
} from "./matter-read";
import {
  matterBookAgain,
  readMatterBookAndRecords,
  type readMatterRecords,
} from "./matters";
import { MATTER_DIRECTIONS } from "./memory-files";
import { meContext } from "./model-context";
import { OWNER } from "./read-truth";
import { lifeRefsOf } from "./refs";
import { begin, checkedEntries, inBatches, readsOf } from "./run";
import { clip } from "./units";
import type { People } from "./who";
import { dayNow } from "./zones";

// The matters' directions (docs/glossary.md: matter direction): for each running matter due one (`isDirectionDue`), one
// model call drafts its goal (where it is going) and its next step (what moves it now, its kind and its context), or, when the matter
// looks over, no next step and the records that show it (`endingRecords`: the links step then judges the observations among them;
// a unit cited from its evidence (`readEvidence`) is not judged, like a draft whose own steps show it over). Each call is one appended line of memory/matter-directions.jsonl (its only writer), each direction pinned to the
// matter's steps, so a re-group keeps it, with its id beside them for a tie (`PINNED`). His word (`matter-direction`, a correction) wins (`directionsOf`).

const PROMPT = "memory-matter-directions.v5";
/** The most characters of matters a night is shown, those with no direction first, then the newest (before their evidence, about 2k more each); and one call. */
export const NIGHT_CHARS = 120_000;
const CALL_CHARS = 30_000;
/** How many of a matter's newest steps a call sees, and how long each one's words. */
const SHOWN_STEPS = 12;
const SHOWN_CHARS = 200;

/** The matters due a direction tonight (`directionDueOf`), each with its later records (`laterShownOf`), and the records read. */
export async function dueDirectionsOf(
  people: People,
  today: string,
  read?: Awaited<ReturnType<typeof readMatterRecords>>
) {
  const { book, records } = read
    ? { book: matterBookAgain(read, today), records: read }
    : await readMatterBookAndRecords(people, today);
  const isDue = directionDueOf(book, records, today);
  return book.flatMap((v) =>
    isDue(v.id)
      ? [{ later: laterShownOf(v, records.observations, records.refOf), v }]
      : []
  );
}

export const NO_EVIDENCE: Evidence = { payments: [], units: [] };

/** A step's `id` for the next step's context to link (`life:`), when it is an observation's. */
const linkOf = (ref: string) =>
  ObservationId.safeParse(ref).success ? { id: ref } : {};

/** A quote: a Markdown quote's line (`> …`), or words in quotation marks. */
const QUOTE = /^\s*>|["“”«»„]/m;

/**
 * Whether a drafted next step's context holds only what its matter's call was shown: every `life:` link one of its
 * steps', later records' or evidence units' ids (a payment has no ref to open), and no quote (`> …` or in quotation marks: the call sees clipped lines, never the checked quotes). Else it is
 * dropped and the next step kept.
 */
const isGroundedContext = (
  context: string,
  shown: {
    later: { id: string }[];
    open: { id?: string }[];
    steps: { id?: string }[];
    units: { id: string }[];
  }
) => {
  const ids = new Set(
    [...shown.steps, ...shown.open, ...shown.later, ...shown.units].flatMap(
      (s) => (s.id ? [s.id] : [])
    )
  );
  return (
    context.trim() !== "" &&
    !QUOTE.test(context) &&
    [...lifeRefsOf(context)].every((id) => ids.has(id))
  );
};

/**
 * A matter as a call is shown it: a call-local id, its name, people, projects, newest steps, what is open, its goal now.
 * `idOf` gives a step its id: an observation's to link, by default; the matter situation's call cites every step's.
 */
export const shownOf = (
  v: MatterView,
  id: string,
  today: string,
  nameOf: (ref: string) => string,
  later: readonly Pick<
    Observation,
    "date" | "id" | "speaker" | "text" | "type"
  >[],
  idOf: (ref: string) => { id?: string } = linkOf
) => ({
  id,
  name: v.name,
  ...(v.goal
    ? {
        goal: {
          by: v.goal.by === "owner" ? "owner" : "draft",
          text: v.goal.text,
        },
      }
    : {}),
  later: later.map((o) => ({
    day: o.date,
    id: o.id,
    kind: o.type,
    said_by: o.speaker === OWNER ? "me" : nameOf(o.speaker),
    text: clip(o.text, SHOWN_CHARS),
  })),
  open: v.openSteps.map((s) => ({
    ...idOf(s.ref),
    ...(s.when ? { due: s.when } : {}),
    kind: s.kind,
    text: clip(s.text, SHOWN_CHARS),
  })),
  people: matterPeopleOf(v).map(nameOf),
  projects: v.projects,
  steps: v.steps.slice(-SHOWN_STEPS).map((s) => ({
    ...idOf(s.ref),
    day: s.day,
    kind: s.kind,
    text: clip(s.text, SHOWN_CHARS),
    ...(s.ending ? { ended: true } : {}),
  })),
  today,
});

/** A reply's direction, by the call's id of its matter. */
const Drafted = MatterDirectionFields.extend({ matter: z.string() })
  .strict()
  .refine(isNextStepOrOver, ONE_OF);

/**
 * Drafts the directions of the matters due tonight (`dueDirectionsOf`) within the night's size, those with none first,
 * then the newest (`all`: every due matter, for the first fill), a few matters a call: one appended line per call once
 * its reply is checked (a failed call leaves its matters due for the next night).
 */
export async function matterDirections(
  people: People,
  {
    all = false,
    today = dayNow(),
    records,
  }: {
    all?: boolean;
    today?: string;
    /** The matter records the night already read (`readMatterRecords`). */
    records?: Awaited<ReturnType<typeof readMatterRecords>>;
  } = {}
) {
  const due = (await dueDirectionsOf(people, today, records)).map((d, i) => ({
    ...d,
    shown: shownOf(d.v, `m${i + 1}`, today, people.nameOf, d.later),
  }));
  if (due.length === 0) {
    return { drafted: 0, due: 0, failed: 0 };
  }
  const chosen = all
    ? due
    : // ponytail: newest first, so on a full night a stale dated matter is the first dropped; today's ~60k of 120k leaves room.
      newestWithin(due, NIGHT_CHARS, {
        // A matter with no direction yet sorts before any drafted one: "~" is after every digit. Then the newest of its last step and its newest later record.
        at: (m) =>
          `${m.v.goal ? "" : "~"}${[m.v.steps.at(-1)?.at ?? "", m.later.at(-1)?.at ?? ""].toSorted().at(-1)}`,
        size: (m) => JSON.stringify(m.shown).length,
      });
  const evidence = await readEvidence(chosen, today);
  const shown = chosen.map((m) => ({
    ...m,
    shown: { ...m.shown, ...(evidence.get(m.v.id) ?? NO_EVIDENCE) },
  }));
  const calls = packed(
    shown,
    CALL_CHARS,
    (m) => JSON.stringify(m.shown).length
  );
  const step = await begin("matter-directions", "fast", { prompt: PROMPT });
  let drafted = 0;
  await inBatches(calls, step, async (call, dir) => {
    await step.attempt(async () => {
      const byId = new Map(call.map((m) => [m.shown.id, m]));
      const reply = await step.ask({
        context: meContext(people.truth),
        dir: join(dir, "call"),
        input: { matters: call.map((m) => m.shown) },
        prompt: PROMPT,
        // A payment is no source's unit: not counted.
        reads: readsOf(
          call.flatMap((m) => [
            ...[
              ...m.v.steps.slice(-SHOWN_STEPS).map((s) => s.ref),
              ...m.v.openSteps.map((s) => s.ref),
              ...m.later.map((o) => o.id),
            ].map((unit) => ({ source: "memory" as const, unit })),
            ...m.shown.units.map((u) => ({ source: u.source, unit: u.id })),
          ])
        ),
      });
      const list = (reply as { directions?: unknown } | null)?.directions;
      const directions = checkedEntries(
        Array.isArray(list) ? list : [],
        Drafted,
        (d) => d.matter,
        (id) => byId.has(id)
      ).entries.flatMap(({ matter, nextStep, ...d }) => {
        const m = byId.get(matter);
        if (!m) {
          return [];
        }
        const laterShown = m.later.map((o) => o.id);
        // A payment cited is read, never stored: it has no ref to open.
        const citable = [...laterShown, ...m.shown.units.map((u) => u.id)];
        const context = nextStep?.context;
        return {
          ...d,
          // Only records the call was shown can be cited.
          ...(d.endingRecords
            ? {
                endingRecords: d.endingRecords.filter((id) =>
                  citable.includes(id)
                ),
              }
            : {}),
          laterShown,
          matter: m.v.id,
          ...(nextStep
            ? {
                nextStep: {
                  ...nextStep,
                  context:
                    context && isGroundedContext(context, m.shown)
                      ? context
                      : undefined,
                },
              }
            : {}),
          steps: m.v.steps.map((s) => s.ref),
        };
      });
      appendJsonl(MATTER_DIRECTIONS, MatterDirectionBatch, [
        {
          at: step.now.toISOString(),
          directions,
          madeBy: step.madeBy(PROMPT),
          schemaVersion: 1,
        },
      ]);
      drafted += directions.length;
    });
  });
  return step.end({ drafted, due: due.length });
}
