import type { EngineInterface, Register } from "claude-code";
import {
  callDoor,
  type Door,
  doorTools,
  type Fetch,
  guardRefusalOf,
  isGuarded,
  isHisTurn,
  lookUpSession,
} from "./door";

// The Life plugin: in a registered agent's session that the desk did not start (he opened it in the Claude app), it
// gives the session its door (the door's own tools, relayed), adds the agent's packet to each turn he typed, and runs
// the desk's send guard before every shell and MCP call, refusing them all when the guard fails. In any other session
// every hook passes the event on untouched. It never starts a turn, sets a wait or decides: the desk does.

/**
 * A session's answer: its agent's door; none (no agent's); `down` (an agent's whose desk can't be asked now: the
 * guard's matcher it last gave); or `unknown` (never looked up, the desk can't be asked now). The last two are asked
 * again after `RETRY_MS`.
 */
type Seen = Door | null | { down: string } | { unknown: true };

/** How long a failed lookup stands before the desk is asked again. */
const RETRY_MS = 30_000;
const DOWN =
  "Life can't be reached and this is a registered agent's session: Life's send guard refuses every shell and MCP call until it answers.";

/** Each session's answer, by session id; a failed one only for `RETRY_MS`. */
const seen = new Map<string, { at: number; seen: Promise<Seen> }>();
/** Whether this process ever held an agent's session: only then does a failed hook refuse a call. */
let isAgentProcess = false;
/** The door tools registered for each session, by the name the model calls (`mcp__<plugin>__<tool>`). */
const registered = new Map<string, Map<string, string>>();

const isDown = (s: Seen): s is { down: string } => s !== null && "down" in s;
const isDoor = (s: Seen): s is Door => s !== null && "key" in s;
const isRetried = (s: Seen) => s !== null && !isDoor(s);

const fetchOf =
  ($: EngineInterface): Fetch =>
  (url, init) =>
    $.http.fetch(url, init);

/**
 * Asks the desk once whose session `id` is, and remembers an agent's (so a later run of it, with the desk down, fails
 * closed); a run the desk started (its guard's environment set) is left to the desk's own door and guard.
 */
async function lookUp($: EngineInterface, id: string): Promise<Seen> {
  const known = `agent-session:${id}`;
  const isDeskRun = (await $.env.get("LIFE_SEND_GUARD")) !== undefined;
  try {
    const door = await lookUpSession(fetchOf($), id);
    if (door) {
      await $.store.set(known, door.matcher);
    }
    return isDeskRun ? null : door;
  } catch {
    if (isDeskRun) {
      return null;
    }
    const matcher = await $.store.get(known);
    return typeof matcher === "string" ? { down: matcher } : { unknown: true };
  }
}

async function seenOf($: EngineInterface) {
  const id = await $.session.id();
  const kept = seen.get(id);
  if (
    !kept ||
    (isRetried(await kept.seen) && Date.now() - kept.at > RETRY_MS)
  ) {
    seen.set(id, { at: Date.now(), seen: lookUp($, id) });
  }
  const s = await (seen.get(id)?.seen ?? null);
  isAgentProcess ||= isDoor(s) || isDown(s);
  if (isDoor(s) && !registered.has(id)) {
    registered.set(id, await registerDoor($, s));
  }
  return { id, s };
}

/** Registers the door's tools as the door lists them, each answered at `tool.call` by the door itself. */
async function registerDoor($: EngineInterface, door: Door) {
  const listed = await doorTools(fetchOf($), door);
  await Promise.all(
    listed.map((t) =>
      $.tool.register({
        description: t.description ?? t.name,
        inputSchema: t.inputSchema,
        isDeferred: false,
        name: t.name,
      })
    )
  );
  const tools = new Map(
    listed.map((t) => [`mcp__${$.plugin.name}__${t.name}`, t.name])
  );
  return tools;
}

/** A call's arguments, as the guard reads `tool_input`: the event less its envelope. */
function inputOf(e: object) {
  const {
    agentId: _a,
    requestMeta: _r,
    tool: _t,
    tool_use_id: _u,
    ...input
  } = e as Record<string, unknown>;
  return input;
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const r = await next(e);
    await seenOf($);
    return r;
  });

  on("prompt.submit", async ($, e, next) => {
    if (e.command || !isHisTurn(e.origin.kind)) {
      return next(e);
    }
    const { s } = await seenOf($);
    if (!isDoor(s)) {
      return next(e);
    }
    // The desk's own words: with several assignments open, the list of them in place of a packet.
    const packet = await callDoor(fetchOf($), s, "read_packet", {});
    return next({ ...e, context: [...(e.context ?? []), packet.text] });
    // A context hook: on any failure his prompt goes on without the packet.
  }).catch((_$, e, next) => next(e));

  on("tool.call", async ($, e, next) => {
    const tool = String(e.tool);
    const { id, s } = await seenOf($);
    if (isDown(s)) {
      return isGuarded(s.down, tool) ? { deny: DOWN } : next(e);
    }
    if (!isDoor(s)) {
      return next(e);
    }
    // Its own door tools are answered by the door, whose rules hold; every other guarded call asks the guard.
    const own = registered.get(id)?.get(tool);
    if (own) {
      const r = await callDoor(fetchOf($), s, own, inputOf(e));
      return r.isError ? { deny: r.text } : { result: r.text };
    }
    if (!isGuarded(s.matcher, tool)) {
      return next(e);
    }
    const why = await guardRefusalOf(fetchOf($), s, tool, inputOf(e));
    return why ? { deny: why } : next(e);
  }).catch((_$, e, next) => {
    if (next.called || !isAgentProcess) {
      return next(e);
    }
    return { deny: "Life's send guard failed, so this call is refused." };
  });
};
