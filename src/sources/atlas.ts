import { lastUpdate, tasksOf } from "../memory/ledger";
import { wall } from "../memory/zones";
import type { SourceEvent } from "../schema";

// Atlas's tasks closed done (src/tasks.ts), each one event: its outcome with the words he asked in. Atlas's own report,
// not checked by Life and not his words: extraction may read it as evidence of what was done (decision 14, 21 Oct).

/** How much of his ask a task's event shows (a spoken ask's quote can hold a whole conversation). */
const ASK_MAX = 1500;

/** The tasks Atlas closed done since `since`, from the actions ledger. */
export function readAtlas(since: Date): SourceEvent[] {
  return tasksOf().flatMap((task) => {
    const { ask } = task;
    const last = lastUpdate(task);
    if (last?.after.state !== "done" || Date.parse(last.at) < since.getTime()) {
      return [];
    }
    const quote = ask.instruction.quote.replaceAll("\n", " ");
    const asked = wall(ask.instruction.at);
    return [
      {
        at: last.at,
        chat: ask.id,
        chatName: `Atlas: ${String(ask.after.title ?? quote).slice(0, 80)}`,
        fromMe: false,
        id: `atlas:${ask.id}`,
        sender: "atlas",
        source: "atlas",
        text: [
          "Atlas reports it did this task (its own report, not checked by Life; not his words).",
          `He had asked, ${asked.day} ${asked.hms.slice(0, 5)}: "${quote.length > ASK_MAX ? `${quote.slice(0, ASK_MAX)}…` : quote}"`,
          `Outcome: ${String(last.after.outcome ?? "")}`,
        ].join("\n"),
      },
    ];
  });
}
