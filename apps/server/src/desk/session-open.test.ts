import { afterEach, expect, setSystemTime, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock, HOUR, MIN } from "../core/clock";
import { logEvents, logFileOf } from "../core/log";
import { HOME } from "../core/platform";
import { agentsNow } from "../host/agents-now";
import { agentOf } from "../host/desk-read";
import { agentLine } from "../host/registered-agents";
import { wakeDue } from "./desk-clock";
import { advance, setup } from "./test-desk";

// The 22 Nov incident: his Claude app kept a process on an agent's session for hours, and its wakes waited silently.
// A wake on a session open outside the desk still waits, and now says so: one log line per opening, and the agent's
// read names where it is open. Made-up agent, session record and process (this test's own).

const RECORDS = join(HOME, ".claude", "sessions");

afterEach(() => {
  setSystemTime();
  rmSync(join(RECORDS, `${process.pid}.json`), { force: true });
});

const opened = () =>
  logEvents(logFileOf(clock().toISOString()), "desk.session_open");

test("a due wake on a session open in his Claude app waits, is logged once, and shows on the agent", async () => {
  const { desk, fake, turns, waiting } = setup();
  const id = await waiting(HOUR);
  const session = agentOf(desk.db, id)?.session ?? "";
  const before = opened().length;
  // His app opens the session: the runtime reads it running, and Claude's record names this process.
  const s = fake.sessions.get(session);
  if (s) {
    s.running = true;
  }
  mkdirSync(RECORDS, { recursive: true });
  writeFileSync(
    join(RECORDS, `${process.pid}.json`),
    JSON.stringify({
      entrypoint: "claude-desktop",
      pid: process.pid,
      sessionId: session,
      startedAt: clock().getTime(),
    })
  );
  const turnsBefore = turns(id).length;
  advance(HOUR + MIN);
  await wakeDue(desk);
  advance(MIN);
  await wakeDue(desk);
  expect(turns(id)).toHaveLength(turnsBefore);
  expect(opened().length - before).toBe(1);
  expect(opened().at(-1)).toMatchObject({ agent: id, runtime: "fake" });

  const a = agentsNow(desk.db, clock().getTime()).find((x) => x.id === id);
  expect(a?.sessionOpenIn).toBe("claude_app");
  expect(a?.sessionOpenSince).toEqual(expect.any(String));
  expect(a?.amber).toContain("session open in your Claude app");
  expect(agentLine(a ?? ({} as never))).toContain(
    "session open in your Claude app"
  );

  // His app lets go: the wake runs, and the agent shows nothing open.
  if (s) {
    s.running = false;
  }
  rmSync(join(RECORDS, `${process.pid}.json`));
  await wakeDue(desk);
  expect(turns(id).length).toBeGreaterThan(turnsBefore);
  expect(
    agentsNow(desk.db, clock().getTime()).find((x) => x.id === id)
      ?.sessionOpenIn ?? null
  ).toBeNull();
});
