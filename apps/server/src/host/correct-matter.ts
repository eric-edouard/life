import {
  type MatterStepNow,
  matterOfSteps,
  openStepsOf,
} from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { recordCorrection } from "../memory/memory-files";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { TICK_LIMIT_MS, tickTodoItems } from "./change-todo-item";
import type { ToolCall } from "./http/mcp-tool";

// His word on a whole matter, by its id (`correct_memory` with `matter`): Life reads which of its steps he means as
// the matter stands now (`matterOf`), so his app never decides what is open or what a goal is pinned to.

/** What an answer is given on top of its send, its Start and its ticks: the reads and the write. */
export const QUICK_MS = 5000;

/** The most his word on the steps `open` may take: one tick per to-do item (`TICK_LIMIT_MS`), then the write. */
export const endLimitMsOf = (open: readonly MatterStepNow[]) =>
  open.filter((s) => s.kind === "todo_item").length * TICK_LIMIT_MS + QUICK_MS;

/**
 * His word that the steps `open` (`openStepsOf`) are done, through the writers that already exist: their to-do items
 * ticked (`tickTodoItems`, with `note`, else Life's words saying he gave none), then their observations by one
 * `outdated` correction. Returns the lines written; none when nothing is open any more.
 */
export async function endByHisWord(
  open: readonly MatterStepNow[],
  note: string | undefined,
  onTicked?: (done: number, of: number, key: string) => void
) {
  const items = open.filter((s) => s.kind === "todo_item").map((s) => s.ref);
  const observations = open
    .filter((s) => s.kind !== "todo_item")
    .map((s) => s.ref);
  const ticked =
    items.length > 0
      ? await tickTodoItems(
          items,
          note ?? "Marked done (Life's words: he gave none).",
          onTicked
        )
      : [];
  return [
    ...ticked,
    ...(observations.length > 0
      ? [await recordCorrection({ kind: "outdated", note, observations })]
      : []),
  ];
}

/**
 * `outdated`: the matter is done, and every step still open, or ended only by a link (until his word), closes
 * (`endByHisWord`). `matter-direction`: his
 * goal or next step, pinned to every step the matter holds. Returns what was written, reporting its plan and steps
 * (`report`, `mcp-tool.ts`): one per to-do item ticked, then `recorded`.
 */
export async function correctMatter(
  correction: Record<string, unknown>,
  report: ToolCall["report"] = () => undefined
) {
  const { matter, ...said } = correction;
  const book = await readMatterBook(await readPeople(), dayNow());
  const v = matterOfSteps(book, [String(matter)]);
  // Only the matter's own id: a step's would mark the whole matter holding it.
  if (!v || v.id !== matter) {
    throw new Error(`Not done: no matter ${matter}; give a matter's id.`);
  }
  if (said.kind === "matter-direction") {
    report({ limitSeconds: QUICK_MS / 1000, plan: ["recorded"] });
    const written = await recordCorrection({
      ...said,
      steps: v.steps.map((s) => s.ref),
    });
    report({ step: "recorded" });
    return [written];
  }
  if (said.kind !== "outdated") {
    throw new Error(
      "Not done: `matter` goes with kind `outdated` (it is done) or `matter-direction`."
    );
  }
  const open = openStepsOf(v);
  if (open.length === 0) {
    throw new Error(`Not done: nothing of ${v.id} is open.`);
  }
  report({
    limitSeconds: Math.ceil(endLimitMsOf(open) / 1000),
    plan: [
      ...(open.some((s) => s.kind === "todo_item")
        ? ["todo_items_ticked"]
        : []),
      "recorded",
    ],
  });
  const written = await endByHisWord(
    open,
    typeof said.note === "string" ? said.note : undefined,
    (done, of, key) => report({ done, key, of, step: "todo_items_ticked" })
  );
  report({ step: "recorded" });
  return written;
}
