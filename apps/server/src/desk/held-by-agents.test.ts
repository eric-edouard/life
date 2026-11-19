import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY } from "../core/clock";
import { agentOf, agentsNow, heldByAgents } from "../host/desk-read";
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

test("two active agents on one project: stopping one leaves it stopped, listed and resumable after ticks", async () => {
  const { desk } = setup();
  const first = agentOn(desk, { project: "test-p" });
  const second = agentOn(desk, { project: "test-p" });
  stop(desk, first);
  await tick(desk, false);
  await tick(desk, false);

  expect(agentOf(desk.db, first)).toMatchObject({
    ended_at: null,
    status: "stopped",
  });
  expect(agentOf(desk.db, second)?.status).toBe("active");
  expect(agentsNow(desk.db, clock().getTime()).map((a) => a.id)).toContain(
    first
  );
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
