import {
  DeletionRequest,
  deleteFromMemory,
} from "../memory/delete-from-memory";
import { changeMatterTodoItems } from "./change-todo-item";
import { blankThreadEntries, threadEntriesHolding } from "./life-thread";

// A deletion as his doors make it (`delete_from_memory`, the main session's, `bun life memory delete`): memory's door,
// then the to-do items it reaches taken off his list as his Drop takes them (`changeMatterTodoItems`, `changeTodoItem`),
// which only this layer may do (`memory/` never touches his list); and the thread entries holding what he deleted,
// found for the preview and blanked by the write (`life-thread.ts`), which memory cannot read.

/**
 * The preview, or with its `confirm` the deletion itself and the to-do items it reached removed from his list; `removed`
 * is how many left it. A list app that refuses one throws, the deletion before it standing.
 */
export async function deleteFromMemoryAndTodoItems(ask: unknown) {
  const done = await deleteFromMemory(ask, threadEntriesHolding);
  if ("entries" in done) {
    blankThreadEntries(done.entries);
  }
  const keys = "reindexed" in done ? done.todoItems : [];
  if (keys.length === 0) {
    return done;
  }
  const removed = await changeMatterTodoItems(
    keys,
    DeletionRequest.parse(ask).said,
    "deleted"
  );
  return { ...done, removed: removed.length };
}
