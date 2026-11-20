import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { changeRegisteredAgent } from "../host/change-registered-agent";
import { expectWire } from "../host/http/wire-fixture";
import { CORRECTIONS, readCorrections } from "../memory/memory-files";
import { register } from "./agent-actions";
import { turnEnded } from "./desk-clock";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { ticking } from "./test-ticker";

// `change_registered_agent`'s answer: a start's stages as the desk's facts are written, from a made-up store and the
// fake runtime. The desk ticks here as its clock does: his word applied, then the turns due.

const folder = mkdtempSync(join(tmpdir(), "life-start-"));
const fake = fakeRuntime();
let desk: Desk;
let personal = "";
const NO_ONE = {
  areas: [],
  lone: false,
  open: true,
  openSteps: [],
  owedTo: [],
  projects: [],
  waitingOn: [],
  with: [],
};
const matter = (n: number) => ({
  ...NO_ONE,
  id: `matter_00000000c00${n}`,
  name: `Test matter ${n}`,
  status: "moving",
  steps: [
    {
      at: "2026-11-17T01:00:00Z",
      kind: "observation",
      ref: `obs_00000000c10${n}`,
      text: `Test step ${n}`,
    },
  ],
});

/** Matter 5's goal is already his word. */
const hisGoal = {
  at: "2026-11-17T02:00:00Z",
  by: "owner",
  text: "Test: his goal",
};

/** The matter-directions recorded, without their stamps. */
const goalsSaved = () =>
  readCorrections().map(({ at: _a, schemaVersion: _v, ...c }) => c);

beforeAll(async () => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(CORRECTIONS, { force: true });
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  desk = { db: openDesk(), runtimes: { claude: fake.runtime } };
  // The Personal agent takes every matter here (none has a project); its own listening waits.
  personal = register(desk, {
    brief: "Test: the Personal agent",
    folder,
    isPersonal: true,
    runtime: "claude",
  });
  desk.db.run("update assignment set wait_until = ? where agent_id = ?", [
    "2099-01-01T00:00:00.000Z",
    personal,
  ]);
  spyOn(await import("../memory/matters"), "readMatterBook").mockResolvedValue([
    ...[1, 2, 3, 4].map(matter),
    { ...matter(5), goal: hisGoal },
  ] as never);
});

afterAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(CORRECTIONS, { force: true });
  setSettings({ desk: null });
});

// Its asks go through `changeRegisteredAgent`, so they carry the connector's own ref (`connector:<ms>`, set by production).
// The ask id is that ref's alone, so another file's ask in the same millisecond (or this file's, on a frozen clock) shares it.
/** A start on matter `n`, the desk ticking `after` ms later; the steps it reports, in order. */
async function start(n: number, said: string, limitMs = 5000, after = 300) {
  const steps: Record<string, unknown>[] = [];
  const stop = ticking(desk, after);
  const result = await changeRegisteredAgent(
    {
      action: "start",
      folder,
      said,
      step: `obs_00000000c10${n}`,
    },
    { report: (s) => steps.push(s) },
    limitMs
  );
  await stop();
  // Its turn ends: the Personal agent runs one turn at a time, and the next start's first turn must begin.
  for (const session of fake.sessions.values()) {
    session.running = false;
  }
  // With a wait set: a turn that ends with none is reminded, and runs again.
  desk.db.run(
    "update turn set outcome = 'waited' where agent_id = ? and ended_at is null",
    [personal]
  );
  await turnEnded(desk, personal, { ok: true });
  return { result, steps };
}

test("a start on a matter reports its plan, saves his words as its goal, then each stage as the desk writes it, and answers started", async () => {
  const { result, steps } = await start(1, "Test: watch matter 1");
  expect(steps.map((s) => s.step ?? "plan")).toEqual([
    "plan",
    "goal_saved",
    "desk_accepted",
    "session_open",
    "turn_begun",
  ]);
  expect(steps[0]).toEqual({
    limitSeconds: 5,
    plan: ["goal_saved", "desk_accepted", "session_open", "turn_begun"],
  });
  expect(goalsSaved()).toEqual([
    {
      goal: "Test: watch matter 1",
      kind: "matter-direction",
      steps: ["obs_00000000c101"],
    },
  ]);
  expect(result).toMatchObject({
    action: "start",
    failed: null,
    nothingRunning: false,
    state: "started",
  });
  const r = result as { agent: string; stages: { session?: string }[] };
  expect(r.stages.map((s) => (s as { stage: string }).stage)).toEqual([
    "desk_accepted",
    "session_open",
    "turn_begun",
  ]);
  expect(r.stages[1]?.session).toBe(`${r.agent}-1`);
  expectWire("change_registered_agent_started", result, true);
});

test("a repeat of the same start answers with the same agent's stages and starts nothing", async () => {
  const before = fake.sessions.size;
  const first = await start(1, "Test: watch matter 1");
  expect(first.result).toMatchObject({ state: "started" });
  expect(fake.sessions.size).toBe(before);
  const again = await start(1, "Test: watch matter 1");
  expect((again.result as { agent: string }).agent).toBe(
    (first.result as { agent: string }).agent
  );
});

test("a start whose words are already his goal writes no second one (the phone's goal-then-start)", async () => {
  const before = goalsSaved().length;
  const { result, steps } = await start(5, hisGoal.text);
  expect(result).toMatchObject({ state: "started" });
  expect(steps.map((s) => s.step ?? "plan").slice(0, 2)).toEqual([
    "plan",
    "goal_saved",
  ]);
  expect(goalsSaved()).toHaveLength(before);
});

test("a matter start whose words cannot be a goal is refused before the desk is asked", async () => {
  const before = goalsSaved().length;
  await expect(
    changeRegisteredAgent({
      action: "start",
      folder,
      said: "x".repeat(201),
      step: "obs_00000000c104",
    })
  ).rejects.toThrow("at most 200 characters");
  expect(goalsSaved()).toHaveLength(before);
});

test("a runtime that does not answer is not_started at its stage, with nothing running", async () => {
  fake.blocked = "claude: command not found";
  // A new agent needs its runtime (a matter's start does not): the Personal agent, while none is registered.
  desk.db.run("update agent set status = 'ended' where id = ?", [personal]);
  const stop = ticking(desk, 300);
  const result = await changeRegisteredAgent(
    { action: "start", personal: true, said: "Test: be my Personal agent" },
    { report: () => undefined },
    5000
  );
  await stop();
  desk.db.run("update agent set status = 'active' where id = ?", [personal]);
  fake.blocked = undefined;
  expect(result).toMatchObject({
    agent: null,
    failed: {
      reason: "claude does not answer: claude: command not found",
      stage: "desk_accepted",
    },
    nothingRunning: true,
    stages: [],
    state: "not_started",
  });
  expectWire("change_registered_agent_not_started", result, true);
});

test("a first turn that never begins is not_started at turn_begun: its assignment is closed, its agent stays", async () => {
  fake.holdBegun();
  setTimeout(() => {
    // Its run ends before it began.
    for (const ref of fake.sessions.keys()) {
      fake.exit(ref, false);
    }
  }, 800);
  const { result } = await start(3, "Test: watch matter 3");
  expect(result).toMatchObject({
    failed: {
      reason: "its first turn ended before it began",
      stage: "turn_begun",
    },
    nothingRunning: true,
    state: "not_started",
  });
  expect((result as { stages: unknown[] }).stages).toHaveLength(2);
  expect(
    desk.db.query("select status from agent where id = ?").get(personal)
  ).toEqual({
    status: "active",
  });
});

test("a desk that does not act within the limit is unconfirmed, at the stage reached", async () => {
  const { result } = await start(4, "Test: watch matter 4", 1000, 60_000);
  expect(result).toMatchObject({
    failed: {
      reason: "no answer from the desk in 1 s",
      stage: "desk_accepted",
    },
    nothingRunning: false,
    state: "unconfirmed",
  });
});

test("a start on a matter already held answers with the agent that holds it", async () => {
  const { result } = await start(1, "Test: other words on matter 1");
  expect(result).toMatchObject({
    agent: personal,
    failed: null,
    runtime: "claude",
    state: "started",
  });
});

test("stop answers done, with no stages", async () => {
  const id = (await start(1, "Test: watch matter 1")).result as {
    agent: string;
  };
  const stop = ticking(desk);
  const stopped = await changeRegisteredAgent({
    action: "stop",
    agent: id.agent as never,
    said: "Test: stop it",
  });
  await stop();
  expect(stopped).toEqual({ action: "stop", agent: id.agent, state: "done" });
});
