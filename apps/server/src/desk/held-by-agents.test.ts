import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY } from "../core/clock";
import {
  agentOf,
  agentsNow,
  agentsOnProjects,
  heldByAgents,
} from "../host/desk-read";
import { register } from "./agent-actions";
import { tick } from "./desk-clock";
import { setup, started } from "./test-desk";

afterEach(() => {
  setSystemTime();
});

test("the inbox's held projects follow the held steps' rule: stopped and recently ended hold; older, never started and a matter's agent do not", async () => {
  const { desk } = setup();
  const day = (n: number) =>
    new Date(clock().getTime() - n * DAY).toISOString();
  const agents: [string | null, string][] = [
    ["test-active", "id = id"],
    ["test-stopped", "status = 'stopped'"],
    ["test-recent", `status = 'ended', ended_at = '${day(1)}'`],
    ["test-old", `status = 'ended', ended_at = '${day(8)}'`],
    ["test-never", "why_not_started = 'x'"],
    [null, "id = id"],
  ];
  const ids = await Promise.all(
    agents.map((_, i) => started(desk, `obs_00000000b02${i}`))
  );
  for (const [i, [project, set]] of agents.entries()) {
    desk.db.run(`update agent set project = ?, ${set} where id = ?`, [
      project,
      ids[i] ?? "",
    ]);
  }
  expect(heldByAgents(desk.db).projects.sort()).toEqual([
    "test-active",
    "test-recent",
    "test-stopped",
  ]);
});

const agentOn = (desk: ReturnType<typeof setup>["desk"], subject: object) =>
  register(desk, {
    brief: "Test brief: watch the repair",
    runtime: "fake",
    ...subject,
  });
const stop = (desk: ReturnType<typeof setup>["desk"], id: string) =>
  desk.db.run("update agent set status = 'stopped' where id = ?", [id]);

test("a stopped agent whose project or matter step has a newer active agent is handed over, and listed nowhere; one with no successor stays stopped", async () => {
  const { desk } = setup();
  const onProject = agentOn(desk, { project: "test-p" });
  const onStep = agentOn(desk, { steps: ["obs_00000000b030"] });
  const alone = agentOn(desk, { project: "test-alone" });
  for (const id of [onProject, onStep, alone]) {
    stop(desk, id);
  }
  const newerProject = agentOn(desk, { project: "test-p" });
  const newerStep = agentOn(desk, { steps: ["obs_00000000b030"] });
  await tick(desk, false);

  for (const [id, by] of [
    [onProject, newerProject],
    [onStep, newerStep],
  ] as const) {
    expect(agentOf(desk.db, id)).toMatchObject({
      outcome: `replaced by ${by}`,
      status: "handed_over",
    });
    expect(agentOf(desk.db, id)?.ended_at).toBe(clock().toISOString());
  }
  const ids = agentsNow(desk.db, clock().getTime()).map((a) => a.id);
  expect(ids).not.toContain(onProject);
  expect(ids).not.toContain(onStep);
  expect(ids).toContain(alone);
  expect(
    agentsOnProjects(desk.db, ["test-p"], clock().getTime()).map((a) => a.id)
  ).toEqual([newerProject]);
  expect(agentOf(desk.db, alone)?.status).toBe("stopped");
});

test("an agent that is over holds its project for NEW_MATTER_DAYS only; a stopped one holds for ever", () => {
  const { desk } = setup();
  const over = agentOn(desk, { project: "test-over" });
  const stopped = agentOn(desk, { project: "test-stopped" });
  stop(desk, stopped);
  desk.db.run(
    "update agent set status = 'handed_over', ended_at = ? where id = ?",
    [new Date(clock().getTime() - 8 * DAY).toISOString(), over]
  );
  expect(heldByAgents(desk.db).projects).toEqual(["test-stopped"]);
  desk.db.run("update agent set ended_at = ? where id = ?", [
    new Date(clock().getTime() - DAY).toISOString(),
    over,
  ]);
  expect(heldByAgents(desk.db).projects.sort()).toEqual([
    "test-over",
    "test-stopped",
  ]);
});
