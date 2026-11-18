import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { changeRegisteredAgent } from "../host/change-registered-agent";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { ticking } from "./test-ticker";

// `change_registered_agent`'s answer: a start's stages as the desk's facts are written, from a made-up store and the
// fake runtime. The desk ticks here as its clock does: his word applied, then the turns due.

const folder = mkdtempSync(join(tmpdir(), "life-start-"));
const fake = fakeRuntime();
let desk: Desk;
const NO_ONE = {
  areas: [],
  lone: false,
  open: true,
  openSteps: [],
  owedTo: [],
  projects: [],
  told: [],
  waitingOn: [],
  with: [],
};
const matter = (n: number) => ({
  ...NO_ONE,
  id: `matter_00000000c00${n}`,
  name: `Test matter ${n}`,
  status: "moving",
  steps: [{ ref: `obs_00000000c10${n}` }],
});

beforeAll(async () => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  desk = { db: openDesk(), runtimes: { claude: fake.runtime } };
  spyOn(await import("../memory/matters"), "readMatterBook").mockResolvedValue(
    [1, 2, 3, 4].map(matter) as never
  );
});

afterAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  setSettings({ desk: null });
});

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
  return { result, steps };
}

test("a start reports its plan, then each stage as the desk writes it, and answers started", async () => {
  const { result, steps } = await start(1, "Test: watch matter 1");
  expect(steps.map((s) => s.step ?? "plan")).toEqual([
    "plan",
    "runtime_answers",
    "session_open",
    "turn_begun",
  ]);
  expect(steps[0]).toEqual({
    limitSeconds: 5,
    plan: ["runtime_answers", "session_open", "turn_begun"],
  });
  expect(result).toMatchObject({
    action: "start",
    failed: null,
    nothingRunning: false,
    state: "started",
  });
  const r = result as { agent: string; stages: { session?: string }[] };
  expect(r.stages.map((s) => (s as { stage: string }).stage)).toEqual([
    "runtime_answers",
    "session_open",
    "turn_begun",
  ]);
  expect(r.stages[1]?.session).toBe(`${r.agent}-1`);
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

test("a runtime that does not answer is not_started at its stage, with nothing running", async () => {
  fake.blocked = "claude: command not found";
  const { result } = await start(2, "Test: watch matter 2");
  fake.blocked = undefined;
  expect(result).toMatchObject({
    agent: null,
    failed: {
      reason: "claude does not answer: claude: command not found",
      stage: "runtime_answers",
    },
    nothingRunning: true,
    stages: [],
    state: "not_started",
  });
});

test("a first turn that never begins is not_started at turn_begun: its agent is ended", async () => {
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
});

test("a desk that does not act within the limit is unconfirmed, at the stage reached", async () => {
  const { result } = await start(4, "Test: watch matter 4", 1000, 60_000);
  expect(result).toMatchObject({
    failed: {
      reason: "no answer from the desk in 1 s",
      stage: "runtime_answers",
    },
    nothingRunning: false,
    state: "unconfirmed",
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
