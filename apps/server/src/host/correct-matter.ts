import { clock } from "../core/clock";
import {
  nextStepContextProblemOf,
  readsOnce,
  type SharedReads,
} from "../memory/find-refs";
import {
  type MatterStepNow,
  type MatterView,
  matterOfSteps,
  openStepsOf,
} from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { recordCorrection } from "../memory/memory-files";
import { type People, readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { Correction } from "../records/observation";
import { changeMatterTodoItems, TICK_LIMIT_MS } from "./change-todo-item";
import type { ToolCall } from "./http/mcp-tool";

// His word on a whole matter, by its id (`correct_memory` with `matter`): Life reads which of its steps he means as
// the matter stands now (`matterOf`), so his app never decides what is open or what a goal is pinned to.

/** What an answer is given on top of its send, its Start and its ticks: the reads and the write. */
export const QUICK_MS = 5000;

/** The most the ticks of his word on the steps `open` may take: one per to-do item (`TICK_LIMIT_MS`). */
export const ticksLimitMsOf = (open: readonly MatterStepNow[]) =>
  open.filter((s) => s.kind === "todo_item").length * TICK_LIMIT_MS;

/** The corrections only his own word writes, whatever they name: his marks on a matter, which project it is of, and his Later on a check. */
const HIS_ONLY_KINDS = new Set([
  "matter-icon",
  "matter-important",
  "matter-project",
  "matter-reopened",
  "deferred",
]);

/** Whether a memory correction is his alone (his token, or his words through Ask Life), through `correctMatter`: one on a whole matter, or one of his marks. */
export const isHisOnly = (correction: Record<string, unknown>) =>
  correction.matter !== undefined ||
  HIS_ONLY_KINDS.has(String(correction.kind));

/** His correction, written once it parses and its next step's `context` opens (`nextStepContextProblemOf`): the door of his own words. */
export async function recordHisCorrection(
  said: unknown,
  reads: SharedReads = readsOnce()
) {
  // Its kind, fields and caps first, so no link is opened for a line that would be refused; `recordCorrection` stamps it again.
  const parsed = Correction.parse({
    ...(said as object),
    at: clock().toISOString(),
    schemaVersion: 1,
  });
  const problem = await nextStepContextProblemOf(parsed, reads);
  if (problem) {
    throw new Error(`Not done: ${problem}.`);
  }
  return recordCorrection(said);
}

/** The action step of one to-do item closed by his word: ticked, or removed on his Drop. */
export const closedStepOf = (isDropped: boolean) =>
  isDropped ? "todo_items_removed" : "todo_items_ticked";

/**
 * His word that the steps `open` (`openStepsOf`) are done, or with `isDropped` won't be done (his Drop), through the
 * writers that already exist: their to-do items ticked, or removed from his list when dropped (`changeMatterTodoItems`, with
 * `note`, else Life's words saying he gave none), then their observations by one `outdated` correction (`outcome`
 * `dropped` when dropped). Returns the lines written; none when nothing is open any more.
 */
export async function endByHisWord(
  open: readonly MatterStepNow[],
  note: string | undefined,
  onClosed?: (done: number, of: number, key: string) => void,
  isDropped = false
) {
  const items = open.filter((s) => s.kind === "todo_item").map((s) => s.ref);
  const observations = open
    .filter((s) => s.kind !== "todo_item")
    .map((s) => s.ref);
  const closed =
    items.length > 0
      ? await changeMatterTodoItems(
          items,
          note ??
            `${isDropped ? "Dropped" : "Marked done"} (Life's words: he gave none).`,
          isDropped ? "remove" : "done",
          onClosed
        )
      : [];
  return [
    ...closed,
    ...(observations.length > 0
      ? [
          await recordCorrection({
            kind: "outdated",
            note,
            observations,
            ...(isDropped ? { outcome: "dropped" } : {}),
          }),
        ]
      : []),
  ];
}

/**
 * His Reopen of the closed matter `v`: its ticked to-do items unticked (`changeMatterTodoItems`), then one
 * `matter-reopened` line pinned to all its steps, which lifts the words and links that closed them. Refused while it
 * is open, and when it would still read closed (`matterBookOf` with the line, its steps ended only by newer records or
 * removed items), so Life does not say reopened for a matter that is not (but see the `ponytail:` corner below).
 */
async function reopenMatter(
  v: MatterView,
  said: Record<string, unknown>,
  people: People,
  report: ToolCall["report"]
) {
  if (v.open) {
    throw new Error(`Not done: ${v.id} is open.`);
  }
  const line = Correction.parse({
    ...said,
    at: clock().toISOString(),
    matter: v.id,
    schemaVersion: 1,
    steps: v.steps.map((s) => s.ref),
  });
  const ticked = v.steps
    .filter(
      (s) =>
        s.kind === "todo_item" &&
        s.ending?.by === "todo_item" &&
        !s.ending.dropped
    )
    .map((s) => s.ref);
  // ponytail: an item ticked then cleared from his list counts here but is left unticked (`changeMatterTodoItems`);
  // a matter of only such items says reopened and stays closed. Read the item's state here if that ever shows up.
  if (ticked.length === 0) {
    const after = await readMatterBook(
      { ...people, corrections: [...people.corrections, line] },
      dayNow()
    );
    if (!matterOfSteps(after, [v.id], v.id)?.open) {
      throw new Error(
        `Not done: nothing of ${v.id} can reopen (its steps ended by newer records or removed from his list).`
      );
    }
  }
  report({
    limitSeconds: Math.ceil((ticked.length * TICK_LIMIT_MS + QUICK_MS) / 1000),
    plan: [...(ticked.length > 0 ? ["todo_items_reopened"] : []), "recorded"],
  });
  const note = typeof said.note === "string" ? said.note : "Reopened.";
  const undone = await changeMatterTodoItems(
    ticked,
    note,
    "undone",
    (done, of, key) => report({ done, key, of, step: "todo_items_reopened" })
  );
  const written = await recordCorrection(line);
  report({ step: "recorded" });
  return [...undone, written];
}

/**
 * `outdated`: the matter is done, or with `outcome` `dropped` won't be done (his Drop), and every step still open, or
 * ended only by a link (until his word, as on a Looks done matter), closes (`endByHisWord`). `matter-direction` (his goal or next step), `matter-important` (his mark, on or off),
 * `matter-icon` (his icon, or null: Life picks again) and `matter-project` (a project of his directory): pinned to
 * every step the matter holds; the line written is the new state. Returns what was written, reporting its plan and steps
 * (`report`, `mcp-tool.ts`): one per to-do item ticked (removed when dropped), then `recorded`.
 */
export async function correctMatter(
  correction: Record<string, unknown>,
  report: ToolCall["report"] = () => undefined
) {
  const { matter, ...said } = correction;
  const people = await readPeople();
  const book = await readMatterBook(people, dayNow());
  const v = matterOfSteps(book, [String(matter)]);
  // Only the matter's own id: a step's would mark the whole matter holding it.
  if (!v || v.id !== matter) {
    throw new Error(`Not done: no matter ${matter}; give a matter's id.`);
  }
  if (
    said.kind === "matter-project" &&
    !people.truth.projects.some((p) => p.id === said.project)
  ) {
    throw new Error(`Not done: no project ${said.project} in his directory.`);
  }
  if (
    said.kind === "matter-direction" ||
    said.kind === "matter-important" ||
    said.kind === "matter-icon" ||
    said.kind === "matter-project"
  ) {
    report({ limitSeconds: QUICK_MS / 1000, plan: ["recorded"] });
    const written = await recordHisCorrection(
      { ...said, matter: v.id, steps: v.steps.map((s) => s.ref) },
      { book: async () => book, people: async () => people }
    );
    report({ step: "recorded" });
    return [written];
  }
  if (said.kind === "matter-reopened") {
    return await reopenMatter(v, said, people, report);
  }
  if (said.kind !== "outdated") {
    throw new Error(
      "Not done: `matter` goes with kind `outdated` (it is done), `matter-reopened`, `matter-direction`, `matter-important`, `matter-icon` or `matter-project`."
    );
  }
  const open = openStepsOf(v);
  if (open.length === 0) {
    throw new Error(`Not done: nothing of ${v.id} is open.`);
  }
  if (said.outcome !== undefined && said.outcome !== "dropped") {
    throw new Error("Not done: `outcome` is `dropped` or left out.");
  }
  const isDropped = said.outcome === "dropped";
  report({
    limitSeconds: Math.ceil((ticksLimitMsOf(open) + QUICK_MS) / 1000),
    plan: [
      ...(open.some((s) => s.kind === "todo_item")
        ? [closedStepOf(isDropped)]
        : []),
      "recorded",
    ],
  });
  const written = await endByHisWord(
    open,
    typeof said.note === "string" ? said.note : undefined,
    (done, of, key) => report({ done, key, of, step: closedStepOf(isDropped) }),
    isDropped
  );
  report({ step: "recorded" });
  return written;
}
