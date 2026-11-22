import { afterEach, expect, setSystemTime, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock, HOUR, MIN } from "../core/clock";
import { logEvents, logFileOf } from "../core/log";
import { DESK_AGENT } from "../core/names";
import { agentsNow } from "../host/agents-now";
import { ask } from "../host/asks";
import { requested } from "../host/change-todo-item";
import { agentChangeOf, agentOf } from "../host/desk-read";
import {
  TERMINAL_ENTRYPOINT,
  TERMINAL_SESSIONS,
} from "../host/open-session-records";
import { register } from "./agent-actions";
import { applyAgentChanges } from "./agent-changes";
import { BUSY } from "./continue-on-mac";
import { wakeDue } from "./desk-clock";
import { advance, setup } from "./test-desk";

// His tap "Continue on your Mac" (22 Nov 2026): refused while a turn runs; while open there the desk holds its wakes;
// once he closes it, they resume on their own. Made-up agents, sessions and Terminal record (this test's own).

const RECORD = join(TERMINAL_SESSIONS, `${process.pid}.json`);

afterEach(() => {
  setSystemTime();
  rmSync(RECORD, { force: true });
});

let n = 0;
/** His tap, as his app's `change_registered_agent` records it; the desk applies it; what it did. */
async function tapped(desk: ReturnType<typeof setup>["desk"], agent: string) {
  n += 1;
  const line = ask(
    requested(`continue-test-${n}`, "Continue on your Mac"),
    {
      agent: DESK_AGENT,
      agentChange: { action: "continue_on_mac", agent },
      confidence: "high",
    },
    "connector",
    "asked in a chat"
  );
  await applyAgentChanges(desk);
  return agentChangeOf(desk.db, line.id);
}

test("refused while its turn runs: nothing opens", async () => {
  const { desk, fake } = setup();
  const id = register(desk, {
    brief: "Test brief: follow up with Ana",
    folder: "/tmp",
    runtime: "fake",
  });
  await wakeDue(desk);
  expect((await tapped(desk, id))?.error).toBe(BUSY);
  expect(fake.continued).toEqual([]);
});

test("open on his Mac, its wakes wait; closed there, they resume with what came in", async () => {
  const { desk, fake, queue, turns, waiting } = setup();
  const id = await waiting(HOUR);
  const session = agentOf(desk.db, id)?.session ?? "";
  expect((await tapped(desk, id))?.error).toBeNull();
  expect(fake.continued).toEqual([session]);
  // Asked once: the desk reading his asks again opens nothing more.
  await applyAgentChanges(desk);
  expect(fake.continued).toHaveLength(1);

  // A second tap while it is open there is refused.
  expect((await tapped(desk, id))?.error).toBe(
    "its session is already open on your Mac"
  );

  // The launcher's record: the agent reads as open in Terminal.
  mkdirSync(TERMINAL_SESSIONS, { recursive: true });
  writeFileSync(
    RECORD,
    JSON.stringify({
      entrypoint: TERMINAL_ENTRYPOINT,
      pid: process.pid,
      sessionId: session,
      startedAt: clock().getTime(),
    })
  );
  const read = () =>
    agentsNow(desk.db, clock().getTime()).find((a) => a.id === id);
  expect(read()?.sessionOpenIn).toBe("terminal");

  const before = turns(id).length;
  queue(id, "whatsapp:m1");
  advance(10 * MIN);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(before);

  // He closes it: pi and its record are gone, and the next tick wakes it on its own.
  const s = fake.sessions.get(session);
  if (s) {
    s.running = false;
  }
  rmSync(RECORD);
  await wakeDue(desk);
  expect(turns(id).length).toBeGreaterThan(before);
  expect(read()?.sessionOpenIn ?? null).toBeNull();
});

test("a runtime that can't open on his Mac is refused by name", async () => {
  const { desk, fake, waiting } = setup();
  const id = await waiting(HOUR);
  const { continueOnMac: _, ...rest } = fake.runtime;
  desk.runtimes.fake = rest;
  expect((await tapped(desk, id))?.error).toBe("not for fake yet");
});

/** A process of this test's recorded as Life's launcher on `session`, its last write `quietFor` ago: named as the launcher, or (`isOther`) any other process that took a dead launcher's pid. */
function holder(session: string, quietFor: number, isOther = false) {
  const p = Bun.spawn(
    isOther
      ? ["sleep", "60"]
      : ["bash", "-c", "exec -a pi-terminal-test sleep 60"]
  );
  mkdirSync(TERMINAL_SESSIONS, { recursive: true });
  writeFileSync(
    join(TERMINAL_SESSIONS, `${p.pid}.json`),
    JSON.stringify({
      entrypoint: TERMINAL_ENTRYPOINT,
      pid: p.pid,
      sessionId: session,
      startedAt: clock().getTime() - quietFor,
      status: "idle",
      statusUpdatedAt: clock().getTime() - quietFor,
    })
  );
  return p;
}

test("he left it on his Mac: quiet 10 minutes, Life takes it back for a due wake, once; quieter than that, it stays his", async () => {
  const { desk, fake, queue, waiting } = setup();
  const id = await waiting(HOUR);
  const session = agentOf(desk.db, id)?.session ?? "";
  await tapped(desk, id);
  queue(id, "whatsapp:m1");
  advance(10 * MIN);
  const taken = () =>
    logEvents(logFileOf(clock().toISOString()), "desk.session_taken_back")
      .length;
  const before = taken();

  const busy = holder(session, 9 * MIN);
  await wakeDue(desk);
  expect(busy.killed || busy.exitCode !== null).toBe(false);
  busy.kill();
  await busy.exited;

  const other = holder(session, 11 * MIN, true);
  await wakeDue(desk);
  expect(other.exitCode).toBeNull();
  // Its record is dropped: the pid's new owner never holds the agent's wakes.
  expect(existsSync(join(TERMINAL_SESSIONS, `${other.pid}.json`))).toBe(false);
  other.kill();
  await other.exited;
  rmSync(join(TERMINAL_SESSIONS, `${other.pid}.json`), { force: true });

  const left = holder(session, 11 * MIN);
  await wakeDue(desk);
  await wakeDue(desk);
  expect(await left.exited).not.toBe(0);
  expect(taken() - before).toBe(1);
  rmSync(join(TERMINAL_SESSIONS, `${left.pid}.json`), { force: true });
  const s = fake.sessions.get(session);
  if (s) {
    s.running = false;
  }
});
