import { AGENT_WORD } from "../core/names";
import { agentName } from "../core/settings";
import type { SourceEvent } from "../records/source";
import type { Newest } from "../sources/contract";
import { lastUpdate, tasksOf } from "./ledger";
import { wall } from "./zones";

// The agent's tasks closed done (apps/server/src/host/agent.ts), each one event: its outcome with the words he asked in. The agent's own report,
// not checked by Life and not his words: extraction may read it as evidence of what was done (decision 14, 21 Oct).

/** How much of his ask a task's event shows (a spoken ask's quote can hold a whole conversation). */
const ASK_MAX = 1500;

/** The tasks the agent closed done itself (its own last update, not his tick in Reminders), from the actions ledger. */
const done = () =>
  tasksOf().flatMap(({ ask, lines }) => {
    const last = lastUpdate({ ask, lines });
    return last?.after.state === "done" && last.via === "connector"
      ? [{ ask, last }]
      : [];
  });

/** The status snapshot's card: when the agent last closed a task done. */
export const newestAgent = (): Newest => ({
  at:
    done()
      .map(({ last }) => last.at)
      .sort()
      .at(-1) ?? null,
});

/** The tasks the agent closed done since `since`. */
export function readAgent(since: Date): SourceEvent[] {
  return done().flatMap(({ ask, last }) => {
    if (Date.parse(last.at) < since.getTime()) {
      return [];
    }
    const quote = ask.instruction.quote.replaceAll("\n", " ");
    const asked = wall(ask.instruction.at);
    return [
      {
        at: last.at,
        chat: ask.id,
        chatName: `${agentName()}: ${String(ask.after.title ?? quote).slice(0, 80)}`,
        fromMe: false,
        id: `${AGENT_WORD}:${ask.id}`,
        sender: AGENT_WORD,
        source: AGENT_WORD,
        text: [
          `${agentName()} reports it did this task (its own report, not checked by Life; not his words).`,
          `He had asked, ${asked.day} ${asked.hms.slice(0, 5)}: "${quote.length > ASK_MAX ? `${quote.slice(0, ASK_MAX)}…` : quote}"`,
          `Outcome: ${String(last.after.outcome ?? "")}`,
        ].join("\n"),
      },
    ];
  });
}
