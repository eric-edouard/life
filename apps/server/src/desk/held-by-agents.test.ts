import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY } from "../core/clock";
import {
  agentOf,
  agentsNow,
  HOLD_DAYS,
  heldByAgents,
} from "../host/desk-read";
import { register } from "./agent-actions";
import { tick } from "./desk-clock";
import { setup, started } from "./test-desk";

afterEach(() => {
  setSystemTime();
});

const agentOn = (desk: ReturnType<typeof setup>["desk"], subject: object) =>
  register(desk, {
    brief: "Test brief: watch the repair",
    runtime: "fake",
    ...subject,
  });
test("every anchored step is a fact for the hold rule: when its assignment closed, who opened it, how it closed; a project's agent's own listening holds nothing; none closed over HOLD_DAYS ago", async () => {
  const { desk } = setup();
  const ended = new Date(clock().getTime() - 30 * DAY).toISOString();
  const handed = await started(desk, "obs_00000000b020");
  const never = await started(desk, "obs_00000000b021");
  /** The agent ended at `at`: its agent and its assignment closed as the desk writes them. */
  const endedAt = (
    id: string,
    at: string,
    set = "",
    args: (string | null)[] = []
  ) => {
    desk.db.run(
      "update agent set status = 'ended', ended_at = ? where id = ?",
      [at, id]
    );
    desk.db.run(
      `update assignment set closed_at = ?${set} where agent_id = ?`,
      [at, ...args, id]
    );
  };
  endedAt(handed, ended, ", opened_by = 'desk', outcome = ?", ["nothing left"]);
  endedAt(never, ended, ", why_not_started = 'x'");
  agentOn(desk, { project: "test-p" });
  const old = await started(desk, "obs_00000000b022");
  endedAt(
    old,
    new Date(clock().getTime() - (HOLD_DAYS + 1) * DAY).toISOString()
  );
  const fact = { status: "ended" as const, whyNotStarted: null };
  expect(heldByAgents(desk.db)).toEqual([
    {
      ...fact,
      agent: handed,
      closedAt: ended,
      openedBy: "desk",
      outcome: "nothing left",
      step: "obs_00000000b020",
    },
    {
      ...fact,
      agent: never,
      closedAt: ended,
      openedBy: "owner",
      outcome: null,
      step: "obs_00000000b021",
      whyNotStarted: "x",
    },
  ]);
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
