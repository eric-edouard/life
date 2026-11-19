import { isOpenUntilHisWord, matterOfSteps } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { recordCorrection } from "../memory/memory-files";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { TICK_LIMIT_MS, tickTodoItems } from "./change-todo-item";
import type { ToolCall } from "./http/mcp-tool";

/** What the reads and writes beside the ticks are given, in seconds. */
const SLACK_S = 5;

// His word on a whole matter, by its id (`correct_memory` with `matter`): Life reads which of its steps he means as
// the matter stands now (`matterOf`), so his app never decides what is open or what a goal is pinned to.

/**
 * `outdated`: the matter is done, and every step still open, or ended only by a link (until his word), closes: its
 * to-do items ticked (`tickTodoItems`), then its observations by his `outdated` correction. `matter-direction`: his
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
    report({ limitSeconds: SLACK_S, plan: ["recorded"] });
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
  const open = v.steps.filter(isOpenUntilHisWord);
  const items = open.filter((s) => s.kind === "todo_item").map((s) => s.ref);
  const observations = open
    .filter((s) => s.kind !== "todo_item")
    .map((s) => s.ref);
  if (open.length === 0) {
    throw new Error(`Not done: nothing of ${v.id} is open.`);
  }
  const note = typeof said.note === "string" ? said.note : undefined;
  report({
    limitSeconds: Math.ceil((items.length * TICK_LIMIT_MS) / 1000) + SLACK_S,
    plan: [...(items.length > 0 ? ["todo_items_ticked"] : []), "recorded"],
  });
  const ticked =
    items.length > 0
      ? await tickTodoItems(
          items,
          note ?? "Marked done (Life's words: he gave none).",
          (done, of, key) =>
            report({ done, key, of, step: "todo_items_ticked" })
        )
      : [];
  const written = [
    ...ticked,
    ...(observations.length > 0
      ? [await recordCorrection({ kind: "outdated", note, observations })]
      : []),
  ];
  report({ step: "recorded" });
  return written;
}
