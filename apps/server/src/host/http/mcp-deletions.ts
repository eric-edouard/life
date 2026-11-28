import type { McpServer } from "@modelcontextprotocol/server";
import { DeletionRequest } from "../../memory/delete-from-memory";
import { deleteFromMemoryAndTodoItems } from "../deletion-door";
import { tool, WRITES } from "./mcp-tool";

// The connector's deletion (`memory/delete-from-memory.ts`): what goes from his memory, his token only, a preview first.

export function deleteFromMemoryTool(server: McpServer, notHis: string) {
  tool(
    server,
    "delete_from_memory",
    "Delete from his memory, only for what he asked: a preview first, then the same set with its `confirm`. `refs` what goes whole (a unit_…, an obs_…, an ep_…, a msg:<source>|<id>, a turn's ref, a file:…, a matter, a card), `cuts` words inside one line (its `ref` and a `quote` of them), or `about` anything about this (found by search, previewed only: it never writes from `about` alone). `withSources` when his word covers the copies in the apps' stores too (raw text in the voice server, the archive and the backups stays as it is until code can purge it). With no `confirm`, nothing is written: its answer is what it would lose (`refs` one line each, `reaches`: the cards withdrawn, the facts, the matters, the to-do items and the units read again, the personas, history months and situations redone), its `cuts`' places, the `days` read again, and the `confirm` to repeat. A `confirm` of another set is previewed again, never written. A person, a project or an area is his directory's: `change_directory_entry`.",
    DeletionRequest,
    (a, agent) => {
      if (agent) {
        throw new Error(notHis);
      }
      return deleteFromMemoryAndTodoItems(a);
    },
    WRITES
  );
}
