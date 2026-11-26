import { rmSync } from "node:fs";
import { join } from "node:path";
import { clock } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { exec } from "../core/proc";
import {
  type AgentRow,
  agentInRole,
  agentOf,
  openTurn,
} from "../host/desk-read";
import {
  hasLeftOf,
  readOpenSessionRecords,
  sessionOpenInOf,
  TERMINAL_ENTRYPOINT,
  TERMINAL_SESSIONS,
} from "../host/open-session-records";
import type { Desk } from "./desk-store";
import { sessionAgentOf } from "./turn-ends";

// His word to continue an agent's session on his Mac (`continue_on_mac`, his app's tap; his decision of 22 Nov 2026):
// the desk opens it there through its runtime (`Runtime.continueOnMac`: pi in Terminal, Claude in his Claude app). While
// it is open there its runtime says `running`, so the desk's wakes wait (`wake`, `desk-clock.ts`) and resume on their own
// once he leaves it: closed, or quiet when a wake is due (`takeBackIfLeft`). No button takes it back.

/** His one refusal while a turn runs: the words his phone shows. */
export const BUSY = "Busy. Try in a moment";

/**
 * Opens agent `id`'s session on his Mac, before his ask's row is written (`applyAgentChanges`, which applies its result):
 * why not, or the agent once it opened. Refused while a desk turn runs, while the session is open elsewhere, before it has
 * a session, and on a runtime that can't (Codex); a stopped agent opens too (nothing wakes it).
 */
export async function continueOnMac(
  desk: Desk,
  id: string | undefined
): Promise<{ error: string } | { id: string }> {
  const a = id ? agentOf(desk.db, id) : null;
  if (!a) {
    return { error: `no registered agent ${id ?? "named"}` };
  }
  if (!["active", "stopped"].includes(a.status)) {
    return { error: `${a.id} is ${a.status}` };
  }
  if (a.role === "main") {
    // Ask Life is its door: it sits in his app's sidebar (`listInApp`), and his hold there is taken back once he left it.
    return { error: "the main session stays in Ask Life" };
  }
  const runtime = desk.runtimes[a.runtime];
  if (!runtime?.continueOnMac) {
    return { error: `not for ${a.runtime} yet` };
  }
  if (openTurn(desk.db, a.id)) {
    return { error: BUSY };
  }
  if (!a.session) {
    return { error: "it has no session yet" };
  }
  if ((await runtime.state(a.session)) === "running") {
    return { error: "its session is already open on your Mac" };
  }
  try {
    await runtime.continueOnMac(sessionAgentOf(a), a.session);
    return { id: a.id };
  } catch (e) {
    return { error: (e as Error).message };
  }
}

/** The holders ended, each once: a holder still ending stays in its record a moment. ponytail: grows by one pid per take-back, for the helper's life. */
const takenBack = new Set<number>();

/**
 * Takes agent `a`'s session back from his Mac once he left it (`hasLeftOf`, his ruling of 22 Nov 2026: no button, Life
 * takes control back by itself): its holder (Life's Terminal launcher, or his Claude app's process for it, each checked by
 * its command line) is ended with SIGTERM, logged once, and the next tick wakes it. Never the desk's own runs (`sdk-*`).
 */
export async function takeBackIfLeft(a: AgentRow) {
  const r = a.session ? readOpenSessionRecords().get(a.session) : undefined;
  if (
    !(r && sessionOpenInOf(r) && hasLeftOf(r, clock().getTime())) ||
    takenBack.has(r.pid)
  ) {
    return;
  }
  // The holder checked by its command line, a record outliving its process (its pid reused) never ends another.
  const { stdout } = await exec(["ps", "-o", "command=", "-p", String(r.pid)]);
  const holder =
    r.entrypoint === TERMINAL_ENTRYPOINT ? "pi-terminal" : "claude";
  if (!stdout.toLowerCase().includes(holder)) {
    // Life's own record outlived its launcher: dropped, so its pid's new owner never holds the agent's wakes.
    if (r.entrypoint === TERMINAL_ENTRYPOINT) {
      rmSync(join(TERMINAL_SESSIONS, `${r.pid}.json`), { force: true });
    }
    return;
  }
  try {
    process.kill(r.pid, "SIGTERM");
    takenBack.add(r.pid);
    log("desk.session_taken_back", { agent: a.id, runtime: a.runtime });
  } catch (e) {
    log("desk.session_taken_back", { agent: a.id, ok: false, ...errorOf(e) });
  }
}

/** `takeBackIfLeft` for the main session, which has no due wake: his app never holds Ask Life past `LEFT_AFTER_MS` quiet. */
export async function takeBackMainIfLeft(desk: Desk) {
  const main = agentInRole(desk.db, "main");
  if (main?.status === "active") {
    await takeBackIfLeft(main);
  }
}
