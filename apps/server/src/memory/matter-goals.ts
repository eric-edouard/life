import { join } from "node:path";
import { z } from "zod";
import { daysBefore } from "../core/clock";
import { appendJsonl } from "../core/files";
import { newestWithin, packed } from "../core/lists";
import { MatterGoalBatch } from "../records/matter";
import type { MatterView } from "./matter-read";
import { readMatterBook } from "./matters";
import { MATTER_GOALS } from "./memory-files";
import { meContext } from "./model-context";
import { begin, checkedEntries, inBatches } from "./run";
import { clip } from "./units";
import type { People } from "./who";
import { dayNow } from "./zones";

// The matters' goals (docs/glossary.md: matter goal): for each matter new in the last days that has none, one model
// call drafts where it is going, in one line, and whether an agent could move it forward. Each call is one appended
// line of memory/matter-goals.jsonl (its only writer), each goal pinned to the matter's steps, never its id, so a
// re-group keeps it. His own goal (`matter-goal`, a correction) always wins (`goalsOf`). A matter with a goal is never
// drafted again: the drafts are cached by the matter's steps and kept across prompt versions.

const PROMPT = "memory-matter-goals.v1";
/** A matter is new while its oldest step is this many days old or less: the first night and a re-group draft no old matter. */
const NEW_DAYS = 7;
/** The most characters of matters a night is shown, the newest first, and one call. */
const NIGHT_CHARS = 120_000;
const CALL_CHARS = 30_000;
/** How many of a matter's newest steps a call sees, and how long each one's words. */
const SHOWN_STEPS = 12;
const SHOWN_CHARS = 200;

/** The matters due a goal on `today`: grouped (not a matter of one), open, with no goal yet, and new (`NEW_DAYS`). Pure. */
export const dueGoalsOf = (book: readonly MatterView[], today: string) => {
  const since = daysBefore(today, NEW_DAYS);
  return book.filter(
    (v) => !(v.lone || v.goal) && v.open && (v.steps[0]?.day ?? "") >= since
  );
};

/** A matter as a call is shown it: a call-local id, its name, its people and projects, its newest steps and what is open. */
const shownOf = (
  v: MatterView,
  id: string,
  nameOf: (ref: string) => string
) => ({
  id,
  name: v.name,
  open: v.openSteps.map((s) => clip(s.text, SHOWN_CHARS)),
  people: [...new Set([...v.owedTo, ...v.waitingOn, ...v.with])].map(nameOf),
  projects: v.projects,
  steps: v.steps.slice(-SHOWN_STEPS).map((s) => ({
    day: s.day,
    kind: s.kind,
    text: clip(s.text, SHOWN_CHARS),
  })),
});

const Drafted = z.object({
  agentCanMove: z.boolean(),
  goal: z.string().trim().min(1).max(200),
  matter: z.string(),
});

/**
 * Drafts the goals of the matters due tonight (`dueGoalsOf`), the newest first within the night's size, a few matters a
 * call: one appended line per call once its reply is checked (a failed call leaves its matters due for the next night).
 */
export async function matterGoals(people: People, today = dayNow()) {
  const due = dueGoalsOf(await readMatterBook(people, today), today).map(
    (v, i) => ({ shown: shownOf(v, `m${i + 1}`, people.nameOf), v })
  );
  if (due.length === 0) {
    return { drafted: 0, due: 0, failed: 0 };
  }
  const size = (m: (typeof due)[number]) => JSON.stringify(m.shown).length;
  const calls = packed(
    newestWithin(due, NIGHT_CHARS, {
      at: (m) => m.v.steps[0]?.at ?? "",
      size,
    }),
    CALL_CHARS,
    size
  );
  const step = await begin("matter-goals", "fast", { prompt: PROMPT });
  let drafted = 0;
  await inBatches(calls, step, async (call, dir) => {
    await step.attempt(async () => {
      const byId = new Map(call.map((m) => [m.shown.id, m.v]));
      const reply = await step.ask({
        context: meContext(people.truth),
        dir: join(dir, "call"),
        input: { matters: call.map((m) => m.shown) },
        prompt: PROMPT,
      });
      const list = (reply as { goals?: unknown } | null)?.goals;
      const goals = checkedEntries(
        Array.isArray(list) ? list : [],
        Drafted,
        (g) => g.matter,
        (id) => byId.has(id)
      ).entries.map((g) => ({
        agentCanMove: g.agentCanMove,
        goal: g.goal,
        steps: byId.get(g.matter)?.steps.map((s) => s.ref) ?? [],
      }));
      appendJsonl(MATTER_GOALS, MatterGoalBatch, [
        {
          at: step.now.toISOString(),
          goals,
          madeBy: step.madeBy(PROMPT),
          schemaVersion: 1,
        },
      ]);
      drafted += goals.length;
    });
  });
  return step.end({ drafted, due: due.length });
}
