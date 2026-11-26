import { agentOf, openTurn } from "../host/desk-read";
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
