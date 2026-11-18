import { join } from "node:path";
import { z } from "zod";
import { appendJsonl } from "../core/files";
import { newestWithin, packed } from "../core/lists";
import { MatterDirectionBatch, MatterDirectionDraft } from "../records/matter";
import { directionsOf, isDirectionDue, type MatterView } from "./matter-read";
import { readMatterBook } from "./matters";
import { MATTER_DIRECTIONS, readDirectionPins } from "./memory-files";
import { meContext } from "./model-context";
import { begin, checkedEntries, inBatches, readsOf } from "./run";
import { clip } from "./units";
import type { People } from "./who";
import { dayNow } from "./zones";

// The matters' directions (docs/glossary.md: matter direction): for each running matter with none, or with a step newer
// than its latest, one model call drafts its goal (where it is going) and its next step (what moves it now, and its
// kind). Each call is one appended line of memory/matter-directions.jsonl (its only writer), each direction pinned to the
// matter's steps, never its id, so a re-group keeps it. His word (`matter-direction`, a correction) wins (`directionsOf`).

const PROMPT = "memory-matter-directions.v1";
/** The most characters of matters a night is shown, those with no direction first, then the newest; and one call. */
const NIGHT_CHARS = 120_000;
const CALL_CHARS = 30_000;
/** How many of a matter's newest steps a call sees, and how long each one's words. */
const SHOWN_STEPS = 12;
const SHOWN_CHARS = 200;

/** The matters due a direction in `book` (`isDirectionDue`), each with its latest pinned next step. Pure. */
export function dueDirectionsOf(book: readonly MatterView[]) {
  const directions = directionsOf(book, readDirectionPins());
  return book.flatMap((v) => {
    const latest = directions.get(v)?.latest;
    return isDirectionDue(v, latest) ? [{ latest, v }] : [];
  });
}

/** A matter as a call is shown it: a call-local id, its name, people, projects, newest steps, what is open, its goal now. */
const shownOf = (
  v: MatterView,
  id: string,
  today: string,
  nameOf: (ref: string) => string
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
  open: v.openSteps.map((s) => ({
    ...(s.when ? { due: s.when } : {}),
    kind: s.kind,
    text: clip(s.text, SHOWN_CHARS),
  })),
  people: [...new Set([...v.owedTo, ...v.waitingOn, ...v.with])].map(nameOf),
  projects: v.projects,
  steps: v.steps.slice(-SHOWN_STEPS).map((s) => ({
    day: s.day,
    kind: s.kind,
    text: clip(s.text, SHOWN_CHARS),
    ...(s.ending ? { ended: true } : {}),
  })),
  today,
});

/** A reply's direction, by the call's id of its matter. */
const Drafted = MatterDirectionDraft.omit({ steps: true }).extend({
  matter: z.string(),
});

/**
 * Drafts the directions of the matters due tonight (`dueDirectionsOf`) within the night's size, those with none first,
 * then the newest (`all`: every due matter, for the first fill), a few matters a call: one appended line per call once
 * its reply is checked (a failed call leaves its matters due for the next night).
 */
export async function matterDirections(
  people: People,
  { all = false, today = dayNow() } = {}
) {
  const due = dueDirectionsOf(await readMatterBook(people, today)).map(
    (d, i) => ({ ...d, shown: shownOf(d.v, `m${i + 1}`, today, people.nameOf) })
  );
  if (due.length === 0) {
    return { drafted: 0, due: 0, failed: 0 };
  }
  const size = (m: (typeof due)[number]) => JSON.stringify(m.shown).length;
  const calls = packed(
    all
      ? due
      : newestWithin(due, NIGHT_CHARS, {
          // A matter with no direction yet sorts before any drafted one: "~" is after every digit.
          at: (m) => `${m.latest ? "" : "~"}${m.v.steps.at(-1)?.at ?? ""}`,
          size,
        }),
    CALL_CHARS,
    size
  );
  const step = await begin("matter-directions", "fast", { prompt: PROMPT });
  let drafted = 0;
  await inBatches(calls, step, async (call, dir) => {
    await step.attempt(async () => {
      const byId = new Map(call.map((m) => [m.shown.id, m.v]));
      const reply = await step.ask({
        context: meContext(people.truth),
        dir: join(dir, "call"),
        input: { matters: call.map((m) => m.shown) },
        prompt: PROMPT,
        reads: readsOf(
          call.flatMap((m) =>
            [...m.v.steps.slice(-SHOWN_STEPS), ...m.v.openSteps].map((s) => ({
              source: "memory",
              unit: s.ref,
            }))
          )
        ),
      });
      const list = (reply as { directions?: unknown } | null)?.directions;
      const directions = checkedEntries(
        Array.isArray(list) ? list : [],
        Drafted,
        (d) => d.matter,
        (id) => byId.has(id)
      ).entries.map(({ matter, ...d }) => ({
        ...d,
        steps: byId.get(matter)?.steps.map((s) => s.ref) ?? [],
      }));
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
