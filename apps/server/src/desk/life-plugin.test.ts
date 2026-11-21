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
import { clock, HOUR, iso } from "../core/clock";
import { DOOR_PORT } from "../host/http/http";
import { openAssignment, register } from "./agent-actions";
import { doorFetch } from "./desk-door";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// The Life plugin against the desk's own door (`doorFetch`): a session he opened himself finds its agent's door, its
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
  expect(early.isError).toBe(true);
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
  expect(isGuarded(door.matcher, "Read")).toBe(false);
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
