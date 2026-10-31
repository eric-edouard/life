import { readFileSync } from "node:fs";
import { clock, DAY, unfrozen } from "../core/clock";
import { linesOf } from "../core/files";
import { digest } from "../core/hash";
import { type Call, log, recentEvents } from "../core/log";
import { HOME } from "../core/platform";
import { start } from "../core/proc";
import { SECRETS, writeSecret } from "../core/secret";
import { agentNames, settings } from "../core/settings";
import { LEDGER, parseLedgerEntry } from "../memory/ledger";
import { zoneNow } from "../memory/zones";
import { agentStartReport, sendReport, unsent } from "./report";

// How far the watcher has looked for new asks: a line number of memory/ledger.jsonl, kept in derived/events.json, so a
// restart starts the agent once for an ask recorded while Life was down, and never again for one it already started on.

/** Lines of the actions ledger already looked at for new asks; none when the file is missing or unreadable (a fresh install). */
export function askCursor(): number | undefined {
  try {
    const n = JSON.parse(readFileSync(SECRETS.events, "utf8")).delivered;
    if (typeof n === "number") {
      return n;
    }
    throw new Error("no line count");
  } catch (e) {
    // Missing: a fresh install. Unreadable: said, since asks recorded meanwhile won't start the agent.
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      log("run.error", {
        error: `ask cursor unreadable, restarting at the ledger's end: ${(e as Error).message}`,
        step: "events.cursor",
      });
    }
  }
}

/** The agents asked at or after line `from` of the ledger, by an ask that is not one an agent made from a chat (already its own). */
export const askedAgents = (lines: string[], from: number) =>
  new Set(
    lines.slice(from).flatMap((line) => {
      const a = parseLedgerEntry(line);
      return a?.kind === "ask" && a.instruction && a.via !== "connector"
        ? [String(a.after.agent)]
        : [];
    })
  );

/** How long an agent may go without reading `read_open_agent_tasks` before Life says it isn't receiving asks. */
const PULL_MS = DAY;

/** Whether his asks reach `agent` now: a `read_open_agent_tasks` call of its own (its grant's agent claim) in the last day (`calls`: the connector's log). */
export async function agentLive(
  now: number,
  agent: string,
  calls = () => recentEvents<Call>(2, "mcp.call")
) {
  return (await calls()).some(
    (e) =>
      e.tool === "read_open_agent_tasks" &&
      !e.error &&
      e.agent === agent &&
      now - Date.parse(e.at) < PULL_MS
  );
}

/**
 * What his own step on his page wakes: his answer wakes the loop that asked; his "Something's wrong" (a request,
 * `asked`) starts the audit; opening the context or revoking wakes none.
 */
export function wakeOf(step: string, loop: string | undefined) {
  if (step === "asked") {
    return { kind: "audit" as const };
  }
  return step === "answered" && loop
    ? { kind: "decision" as const, loop }
    : undefined;
}

/**
 * The one way Life starts an agent: its `start` command, once, in his home, with the event's JSON appended,
 * his zone added (`{kind:"ask"}` on a new ask for it, `{kind:"tick", at}` each minute from the watcher, `{kind:"message", chats}`
 * when the archive copied messages from someone else, `messagesIn`, those two only when its `start.on` names them;
 * `{kind:"decision", loop}` when he answers one of its decisions on his page, `{kind:"audit"}` when he files a
 * "Something's wrong" there, `wakeOf`). The command decides what the event starts; Life never waits on it. A start that
 * fails is logged.
 */
export function startAgent(
  name: string,
  event:
    | { kind: "ask" }
    | { kind: "audit" }
    | { kind: "tick"; at: string }
    | { chats: { chat: string; source: string }[]; kind: "message" }
    | { kind: "decision"; loop: string }
) {
  const s = settings().agents?.[name]?.start;
  const { kind } = event;
  if (!s || ((kind === "tick" || kind === "message") && !s.on.includes(kind))) {
    return;
  }
  unfrozen("start the agent");
  const error = start(
    [...s.command, JSON.stringify({ ...event, zone: zoneNow() })],
    HOME,
    (said) => agentSaid(name, said)
  );
  if (error) {
    log("run.error", { error, step: "events.start" });
  }
}

/**
 * What his agent's starter says is wrong, by exiting non-zero (life-loops: a loop missed its run, a run failed, the day's
 * cap; or the starter itself broke): one mail with the lines not mailed before (`sendReport` keeps the keys), none when
 * every line was. Its words are its own report about itself, never recorded content.
 */
let saying = Promise.resolve();
// One at a time, so two starters exiting together can't both find a line unsent and mail it twice.
function agentSaid(agent: string, said: string) {
  saying = saying
    .then(() => mailNew(agent, said))
    .catch((e) =>
      log("run.error", { error: (e as Error).message, step: "events.start" })
    );
}
async function mailNew(agent: string, said: string) {
  const lines = [...new Set(said.split("\n").map((l) => l.trim()))].filter(
    Boolean
  );
  const keyOf = (l: string) => `agent-start/${digest("sha1", l, 12)}`;
  const fresh = new Set(await unsent(lines.map(keyOf)));
  const news = lines.filter((l) => fresh.has(keyOf(l)));
  if (news.length > 0) {
    await sendReport(
      news.map(keyOf),
      agentStartReport(agent, news, clock().getTime())
    );
  }
}

/** Starts each agent that `event` reaches (a tick, a message): those whose `start.on` names it. */
export const startAgents = (
  event: Parameters<typeof startAgent>[1] & { kind: "tick" | "message" }
) => {
  for (const name of agentNames()) {
    startAgent(name, event);
  }
};

/**
 * A new ask past the cursor starts its agent with `{kind:"ask"}` (the watcher calls it every loop) and the cursor moves
 * to the end. The ask still shows on `read_open_agent_tasks`, and Life emails him when it isn't taken in 30 min.
 */
export function startOnAsk() {
  const lines = linesOf(LEDGER);
  const cursor = askCursor();
  // No cursor: start from the end, and write it now, or every pass would start from a new end and miss the ask between.
  for (const agent of cursor === undefined ? [] : askedAgents(lines, cursor)) {
    startAgent(agent, { kind: "ask" });
  }
  if (cursor !== lines.length) {
    writeSecret("events", `${JSON.stringify({ delivered: lines.length })}\n`);
  }
}
