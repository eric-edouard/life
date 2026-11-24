import {
  DeletionRequest,
  deleteFromMemory,
} from "../memory/delete-from-memory";
import { changeMatterTodoItems, openTodoItemKeys } from "./change-todo-item";

// A deletion as his doors make it (`delete_from_memory`, the main session's, `bun life memory delete`): memory's door,
// then the to-do items it reaches taken off his list as his Drop takes them (`changeMatterTodoItems`, `changeTodoItem`),
// which only this layer may do (`memory/` never touches his list).

/**
 * The preview, or with its `confirm` the deletion itself and the to-do items it reached removed from his list; `removed`
 * is how many left it. A list app that refuses one throws, the deletion before it standing.
 */
export async function deleteFromMemoryAndTodoItems(ask: unknown) {
  const done = await deleteFromMemory(ask);
  // A key of another install's list app is not on this one's: it stays as it is (`changeTodoItem` refuses it).
  const here = new Set(await openTodoItemKeys());
  const keys =
    "reindexed" in done ? done.todoItems.filter((k) => here.has(k)) : [];
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
