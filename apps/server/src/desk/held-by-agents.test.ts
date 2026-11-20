import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY } from "../core/clock";
import { agentOf, agentsNow, HOLD_DAYS, heldByAgents } from "../host/desk-read";
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
test("every subject is a fact for the hold rule: when its agent ended, who started it, how it ended; none ended over HOLD_DAYS ago", async () => {
  const { desk } = setup();
  const ended = new Date(clock().getTime() - 30 * DAY).toISOString();
  const handed = await started(desk, "obs_00000000b020");
  const never = await started(desk, "obs_00000000b021");
  desk.db.run(
    "update agent set is_handed_out = 1, status = 'ended', ended_at = ?, outcome = 'nothing left' where id = ?",
    [ended, handed]
  );
  desk.db.run(
    "update agent set status = 'ended', ended_at = ?, why_not_started = 'x' where id = ?",
    [ended, never]
  );
  agentOn(desk, { project: "test-p" });
  const old = await started(desk, "obs_00000000b022");
  desk.db.run("update agent set status = 'ended', ended_at = ? where id = ?", [
    new Date(clock().getTime() - (HOLD_DAYS + 1) * DAY).toISOString(),
    old,
  ]);
  const fact = { project: null, whyNotStarted: null };
  expect(heldByAgents(desk.db)).toEqual([
    {
      ...fact,
      endedAt: ended,
      kind: "handed_out",
      outcome: "nothing left",
      step: "obs_00000000b020",
    },
    {
      ...fact,
      endedAt: ended,
      kind: "asked",
      outcome: null,
      step: "obs_00000000b021",
      whyNotStarted: "x",
    },
    {
      ...fact,
      endedAt: null,
      kind: "asked",
      outcome: null,
      project: "test-p",
      step: null,
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
