import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY } from "../core/clock";
import { heldByAgents } from "../host/desk-read";
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
