import { existsSync, readFileSync } from "node:fs";
import { clock, DAY, unfrozen } from "../core/clock";
import { linesOf } from "../core/files";
import { digest } from "../core/hash";
import { type Call, isAgent, log, recentEvents } from "../core/log";
import { HOME } from "../core/platform";
import { start } from "../core/proc";
import { SECRETS, writeSecret } from "../core/secret";
import { agentName, settings } from "../core/settings";
import { LEDGER, parseLedgerEntry } from "../memory/ledger";
import { zoneNow } from "../memory/zones";
import { agentStartReport, sendReport, unsent } from "./report";

// How far the watcher has looked for new asks: a line number of memory/ledger.jsonl, kept in derived/events.json, so a
// restart starts the agent once for an ask recorded while Life was down, and never again for one it already started on.

/** Who a connector call came from, by its user agent: the names he knows them by. */
export function clientName(agent: unknown) {
  const a = String(agent ?? "");
  if (isAgent(a)) {
    return agentName();
  }
  return a.toLowerCase().includes("claude") ? "Claude" : a || "unknown client";
}

/** Lines of the actions ledger already looked at for new asks. */
export const askCursor = (): number =>
  existsSync(SECRETS.events)
    ? JSON.parse(readFileSync(SECRETS.events, "utf8")).delivered
    : linesOf(LEDGER).length;

/** Whether the ledger holds an ask at or after line `from` that is not one the agent made from a chat (already its own). */
export const hasNewAsk = (lines: string[], from: number) =>
  lines.slice(from).some((line) => {
    const a = parseLedgerEntry(line);
    return a?.kind === "ask" && !!a.instruction && a.via !== "connector";
  });

/** How long the agent may go without reading `read_open_agent_tasks` before Life says it isn't receiving asks. */
const PULL_MS = DAY;

/** Whether his asks reach his agent now: a `read_open_agent_tasks` call of its own in the last day (`calls`: the connector's log). */
export async function agentLive(
  now: number,
  calls = () => recentEvents<Call>(2, "mcp.call")
) {
  return (await calls()).some(
    (e) =>
      e.tool === "read_open_agent_tasks" &&
      !e.error &&
      isAgent(e.agent) &&
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
 * The one way Life starts the agent: its `start` command, once, in his home, with the event's JSON appended,
 * his zone added (`{kind:"ask"}` on a new ask, `{kind:"tick", at}` each minute from the watcher, `{kind:"message", chats}`
 * when the archive copied messages from someone else, `messagesIn`; `{kind:"decision", loop}` when he answers one of a
 * loop's decisions on his page, `{kind:"audit"}` when he files a "Something's wrong" there, `wakeOf`). The command decides
 * what the event starts; Life never waits on it. A start that fails is logged.
 */
export function startAgent(
  event:
    | { kind: "ask" }
    | { kind: "audit" }
    | { kind: "tick"; at: string }
    | { chats: { chat: string; source: string }[]; kind: "message" }
    | { kind: "decision"; loop: string }
) {
  const cmd = settings().agent?.start;
  if (!cmd) {
    return;
  }
  unfrozen("start the agent");
  const error = start(
    [...cmd, JSON.stringify({ ...event, zone: zoneNow() })],
    HOME,
    agentSaid
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
function agentSaid(said: string) {
  saying = saying
    .then(() => mailNew(said))
    .catch((e) =>
      log("run.error", { error: (e as Error).message, step: "events.start" })
    );
}
async function mailNew(said: string) {
  const lines = [...new Set(said.split("\n").map((l) => l.trim()))].filter(
    Boolean
  );
  const keyOf = (l: string) => `agent-start/${digest("sha1", l, 12)}`;
  const fresh = new Set(await unsent(lines.map(keyOf)));
  const news = lines.filter((l) => fresh.has(keyOf(l)));
  if (news.length > 0) {
    await sendReport(
      news.map(keyOf),
      agentStartReport(news, clock().getTime())
    );
  }
}

/**
 * A new ask past the cursor starts the agent with `{kind:"ask"}` (the watcher calls it every loop) and the cursor moves to
 * the end. The ask still shows on `read_open_agent_tasks`, and Life emails him when it isn't taken in 30 min.
 */
export function startOnAsk() {
  const lines = linesOf(LEDGER);
  const from = askCursor();
  if (hasNewAsk(lines, from)) {
    startAgent({ kind: "ask" });
  }
  if (from < lines.length) {
    writeSecret("events", `${JSON.stringify({ delivered: lines.length })}\n`);
  }
}
