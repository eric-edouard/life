import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  callDoor,
  DOOR,
  doorTools,
  type Fetch,
  guardRefusalOf,
  isGuarded,
  isHisTurn,
  lookUpSession,
} from "../../../claude-plugin/hooks/door";
import { register as registerPlugin } from "../../../claude-plugin/hooks/life";
import { clock, HOUR, iso } from "../core/clock";
import { DOOR_PORT } from "../host/http/http";
import { openAssignment, register } from "./agent-actions";
import { doorFetch } from "./desk-door";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// The Life plugin (door.ts, and life.ts through a fake engine) against the desk's own door (`doorFetch`): a session he opened himself finds its agent's door, its
// calls act outside a desk turn, and the send guard answers. Made-up agents, briefs and sessions.

const dir = mkdtempSync(join(tmpdir(), "life-plugin-"));
const desk: Desk = {
  db: openDesk(join(dir, "desk.sqlite")),
  runtimes: { fake: fakeRuntime().runtime },
};
// His addresses and the repos agents post to, made up: the test never reads this Mac's Mail.
const handle = doorFetch(desk, () => ({
  ownAddresses: ["owner@example.test"],
  postRepos: [],
}));
/** The plugin's fetch, served by the door in this process. */
const fetch: Fetch = async (url, init) => {
  const r = await handle(new Request(url, init));
  return { status: r.status, text: await r.text() };
};

/** A made-up agent whose session `ref` the desk started, no desk turn running. */
function agentWithSession(ref: string) {
  const id = register(desk, {
    brief: "Test brief: a made-up bakery's order",
    folder: dir,
    runtime: "fake",
  });
  desk.db.run(
    "insert into session (agent_id, runtime, ref, link, started_at) values (?, 'fake', ?, ?, ?)",
    [id, ref, `fake://${ref}`, clock().toISOString()]
  );
  desk.db.run("update agent set session = ? where id = ?", [ref, id]);
  return id;
}

test("the plugin reaches his own Life's door", () => {
  expect(DOOR).toBe(`http://127.0.0.1:${DOOR_PORT}`);
});

test("a session is an agent's only when the desk holds it, and only from a loopback host", async () => {
  const id = agentWithSession("sess-bakery-1");
  expect(await lookUpSession(fetch, "sess-unknown")).toBeNull();
  const door = await lookUpSession(fetch, "sess-bakery-1");
  expect(door?.agent).toBe(id);
  expect(door?.url).toBe(`${DOOR}/mcp/${id}`);
  const foreign = await handle(
    new Request("http://evil.test/session/sess-bakery-1")
  );
  expect(foreign.status).toBe(404);
});

test("his turn outside a desk turn reads the packet and acts on the agent's one open assignment", async () => {
  agentWithSession("sess-bakery-2");
  const door = await lookUpSession(fetch, "sess-bakery-2");
  if (!door) {
    throw new Error("no door");
  }
  expect((await doorTools(fetch, door)).map((t) => t.name)).toContain(
    "request_decision"
  );
  const packet = await callDoor(fetch, door, "read_packet", {});
  expect(packet.isError).toBe(false);
  expect(packet.text).toContain("No desk turn of yours is running");
  expect(packet.text).toContain("Test brief: a made-up bakery's order");
  const notes = await callDoor(fetch, door, "write_notes", {
    text: "Test notes: he asked for a blue cake.",
  });
  expect(notes.isError).toBe(false);
  const early = await callDoor(fetch, door, "set_wait", {
    events: [],
    reason: "Test: the baker's answer",
    until: iso(clock().getTime() + HOUR),
  });
  // No plan card (his yes of 25 Nov 2026): his turn may wait with no card.
  expect(early.isError).toBe(false);
});

test("with several assignments open, his turn names one: none named lists them", async () => {
  const id = agentWithSession("sess-bakery-3");
  const second = openAssignment(desk, id, {
    openedBy: "owner",
    steps: ["obs_test_cake"],
  });
  const door = await lookUpSession(fetch, "sess-bakery-3");
  if (!door) {
    throw new Error("no door");
  }
  const listed = await callDoor(fetch, door, "write_notes", { text: "x" });
  expect(listed.isError).toBe(true);
  expect(listed.text).toContain(second);
  const named = await callDoor(fetch, door, "write_notes", {
    assignment: second,
    text: "Test notes on the cake matter.",
  });
  expect(named.isError).toBe(false);
});

test("the send guard answers his turn's calls, and refuses when it can't be asked", async () => {
  agentWithSession("sess-bakery-4");
  const door = await lookUpSession(fetch, "sess-bakery-4");
  if (!door) {
    throw new Error("no door");
  }
  expect(isGuarded(door.matcher, "Bash")).toBe(true);
  // Every tool, whatever its name (the v4 plan, bundle C).
  expect(isGuarded(door.matcher, "Read")).toBe(true);
  expect(
    await guardRefusalOf(fetch, door, "Bash", {
      command: "gog gmail send --to someone@example.test --body hi",
    })
  ).toContain("send guard refused");
  expect(await guardRefusalOf(fetch, door, "Bash", { command: "ls" })).toBe(
    null
  );
  const down: Fetch = () => Promise.reject(new Error("connection refused"));
  expect(await guardRefusalOf(down, door, "Bash", { command: "ls" })).toContain(
    "refused"
  );
  const wrongKey = { ...door, key: "0".repeat(64) };
  expect(
    await guardRefusalOf(fetch, wrongKey, "Bash", { command: "ls" })
  ).toContain("refused");
});

test("his turns are the ones he typed or sent from his phone", () => {
  expect(isHisTurn("composer")).toBe(true);
  expect(isHisTurn("bridge")).toBe(true);
  expect(isHisTurn("sdk")).toBe(false);
  expect(isHisTurn("scheduled-trigger")).toBe(false);
});

/** A fake engine: `$` over the door's own handler (or none when `down`), `env` and a store; the hooks as registered. */
function engineOf(
  session: string,
  opts: { down?: boolean; env?: string } = {}
) {
  const kept = new Map<string, unknown>();
  const registered: string[] = [];
  const hooks = new Map<string, (...a: any[]) => Promise<any>>();
  registerPlugin((event, h) => {
    hooks.set(event, h);
    return { catch: () => undefined };
  });
  const $ = {
    env: { get: async () => opts.env },
    http: {
      fetch: opts.down
        ? () => Promise.reject(new Error("connection refused"))
        : fetch,
    },
    plugin: { name: "life" },
    session: { id: async () => session },
    store: {
      get: async (k: string) => kept.get(k),
      set: (k: string, v: unknown) => {
        kept.set(k, v);
        return Promise.resolve();
      },
    },
    tool: {
      register: (t: { name: string }) => {
        registered.push(t.name);
        return Promise.resolve();
      },
    },
  };
  const next = Object.assign(async (e: unknown) => ({ passed: e }), {
    called: false,
  });
  const call = (tool: string, input: object = {}) =>
    // biome-ignore lint/style/noNonNullAssertion: registered above
    hooks.get("tool.call")!($, { tool, ...input }, next);
  /** `tool.check` on `tool` over the engine's own verdict `decision` (and an organization's `ceiling`, if any). */
  const check = (tool: string, decision: string, ceiling?: string) =>
    // biome-ignore lint/style/noNonNullAssertion: registered above
    hooks.get("tool.check")!(
      $,
      { ceiling, input: {}, tool },
      Object.assign(async () => ({ decision }), { called: false })
    );
  return { $, call, check, kept, registered };
}

test("the plugin's module: a known session with Life down denies every call but the file tools, which the guard never refuses", async () => {
  agentWithSession("sess-plugin-1");
  const door = await lookUpSession(fetch, "sess-plugin-1");
  const e = engineOf("sess-plugin-1", { down: true });
  e.kept.set("agent-session:sess-plugin-1", door?.matcher);
  expect(await e.call("Bash", { command: "ls" })).toHaveProperty("deny");
  expect(await e.call("Read", { file_path: "x" })).toHaveProperty("passed");
  expect(await e.call("Edit", { file_path: "x" })).toHaveProperty("passed");
  expect(await e.call("WebFetch", { url: "https://x.test" })).toHaveProperty(
    "deny"
  );
  expect(await e.call("mcp__x__send_message", {})).toHaveProperty("deny");
});

test("the plugin's module: its door's tools are registered and answered by the door", async () => {
  agentWithSession("sess-plugin-2");
  const e = engineOf("sess-plugin-2");
  const r = await e.call("mcp__life__write_notes", {
    text: "Test notes: cake.",
  });
  expect(e.registered).toContain("write_notes");
  expect(r).toHaveProperty("result");
});

test("the plugin's module: a session the desk started (LIFE_SEND_GUARD set) passes everything", async () => {
  agentWithSession("sess-plugin-3");
  const e = engineOf("sess-plugin-3", { env: "1" });
  expect(
    await e.call("Bash", { command: "gog gmail send --to a@example.test" })
  ).toHaveProperty("passed");
  // The control: the same call in an agent's session without the desk's environment is refused by the guard.
  agentWithSession("sess-plugin-4");
  expect(
    await engineOf("sess-plugin-4").call("Bash", {
      command: "gog gmail send --to a@example.test",
    })
  ).toHaveProperty("deny");
});

test("the plugin's module: an agent's session he opened in his app asks nothing, as the desk runs it; a deny, an organization's ceiling, Life down and any other session keep their verdict (26 Nov 2026)", async () => {
  agentWithSession("sess-plugin-5");
  const own = engineOf("sess-plugin-5");
  expect(
    await own.check("mcp__plugin_life_life__read_life_status", "ask")
  ).toMatchObject({
    decision: "allow",
  });
  expect(await own.check("Bash", "deny")).toEqual({ decision: "deny" });
  expect(await own.check("mcp__x__tool", "ask", "ask")).toEqual({
    decision: "ask",
  });
  expect(await engineOf("sess-not-an-agent").check("Bash", "ask")).toEqual({
    decision: "ask",
  });
  const down = engineOf("sess-plugin-5-down", { down: true });
  down.kept.set("agent-session:sess-plugin-5-down", "Bash");
  expect(await down.check("Bash", "ask")).toEqual({ decision: "ask" });
});
