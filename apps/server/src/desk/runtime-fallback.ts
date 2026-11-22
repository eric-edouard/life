import { log } from "../core/log";
import { BUILT_IN_RUNTIME } from "../core/names";
import type { AgentRow } from "../host/desk-read";
import type { Desk } from "./desk-store";

// The runtime fallback (the owner's word of 22 Nov 2026: a new user may have no Claude or Codex, and everything must
// still work through pi). A start is refused only when pi can't run either; an agent with no session yet whose runtime
// can't run takes pi at its wake, for good. An agent with a session never switches here (one agent, one session: a
// session can't change runtime): it waits on its runtime, its health says so, and his move (`hand_over`) offers another.
// Back home once its runtime runs again is that same move, offered by `moveToOf`.

/** Why `runtime` can't run now: its own block, or none the desk drives by that name. */
export const blockOf = async (desk: Desk, runtime: string) => {
  const r = desk.runtimes[runtime];
  return r ? await r.block() : `no runtime ${runtime} the desk drives`;
};

/** Why a start on `runtime` can't run: none while it, or else pi, runs. */
export async function startBlockOf(desk: Desk, runtime: string) {
  const why = await blockOf(desk, runtime);
  if (!why || runtime === BUILT_IN_RUNTIME) {
    return why;
  }
  const pi = await blockOf(desk, BUILT_IN_RUNTIME);
  return pi && `${why}; ${BUILT_IN_RUNTIME}: ${pi}`;
}

/** Agent `id` on `runtime`, with its model, effort, session and link cleared: the next turn starts fresh there (his runtime switch's commit, and the fallback). */
export const setRuntime = (db: Desk["db"], id: string, runtime: string) =>
  db.run(
    "update agent set runtime = ?, model = null, effort = null, session = null, link = null where id = ?",
    [runtime, id]
  );

/**
 * Agent `a` as it runs now: on pi when it has no session yet and its runtime can't run while pi can (said once in the
 * log, `desk.runtime_fallback`: after it, its runtime is pi); else as it is. `block` is the caller's, asked once per runtime.
 */
export async function runnableAgentOf(
  desk: Desk,
  a: AgentRow,
  block = (runtime: string) => blockOf(desk, runtime)
): Promise<AgentRow> {
  if (a.session || a.runtime === BUILT_IN_RUNTIME) {
    return a;
  }
  const why = await block(a.runtime);
  if (!why || (await block(BUILT_IN_RUNTIME))) {
    return a;
  }
  setRuntime(desk.db, a.id, BUILT_IN_RUNTIME);
  log("desk.runtime_fallback", {
    agent: a.id,
    from: a.runtime,
    to: BUILT_IN_RUNTIME,
    why,
  });
  return {
    ...a,
    effort: null,
    link: null,
    model: null,
    runtime: BUILT_IN_RUNTIME,
  };
}
