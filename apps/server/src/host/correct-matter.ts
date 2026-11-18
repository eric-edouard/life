import { ACTIONABLE, matterOfSteps } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { recordCorrection } from "../memory/memory-files";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { tickTodoItems } from "./change-todo-item";

// His word on a whole matter, by its id (`correct_memory` with `matter`): Life reads which of its steps he means as
// the matter stands now (`matterOf`), so his app never decides what is open or what a goal is pinned to.

/**
 * `outdated`: the matter is done, and every step still open, or ended only by a link (until his word), closes: its
 * to-do items ticked (`tickTodoItems`), then its observations by his `outdated` correction. `matter-direction`: his
 * goal or next step, pinned to every step the matter holds. Returns what was written.
 */
export async function correctMatter(correction: Record<string, unknown>) {
  const { matter, ...said } = correction;
  const book = await readMatterBook(await readPeople(), dayNow());
  const v = matterOfSteps(book, [String(matter)]);
  if (!v) {
    throw new Error(`Not done: no matter ${matter}.`);
  }
  if (said.kind === "matter-direction") {
    return [
      await recordCorrection({ ...said, steps: v.steps.map((s) => s.ref) }),
    ];
  }
  if (said.kind !== "outdated") {
    throw new Error(
      "Not done: `matter` goes with kind `outdated` (it is done) or `matter-direction`."
    );
  }
  const open = v.steps.filter(
    (s) => ACTIONABLE.includes(s.kind) && (!s.ending || s.ending.by === "link")
  );
  const items = open.filter((s) => s.kind === "todo_item").map((s) => s.ref);
  const observations = open
    .filter((s) => s.kind !== "todo_item")
    .map((s) => s.ref);
  if (open.length === 0) {
    throw new Error(`Not done: nothing of ${v.id} is open.`);
  }
  const note = typeof said.note === "string" ? said.note : "It is done.";
  const ticked = items.length > 0 ? await tickTodoItems(items, note) : [];
  return [
    ...ticked,
    ...(observations.length > 0
      ? [await recordCorrection({ kind: "outdated", note, observations })]
      : []),
  ];
}
