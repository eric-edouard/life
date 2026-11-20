import { afterEach, expect, setSystemTime, test } from "bun:test";
import { HOUR } from "../core/clock";
import { agentOf } from "../host/desk-read";
import { setWait } from "./agent-actions";
import { wakeDue } from "./desk-clock";
import { advance, ahead, on, setup, started } from "./test-desk";

afterEach(() => {
  setSystemTime();
});

test("a turn's context is kept as its run reports it, the session's first call once", async () => {
  const { desk, fake } = setup();
  const id = await started(desk, "obs_00000000b015");
  const ref = agentOf(desk.db, id)?.session ?? "";
  const usage = (n: number) => ({
    contextFirst: n,
    contextLast: n + 500,
    tokensCached: 1,
    tokensIn: 2,
    tokensOut: 3,
  });
  const wait = () =>
    setWait(desk, on(desk, id), {
      events: [],
      reason: "r",
      until: ahead(HOUR),
    });
  await wait();
  fake.exit(ref, true, { usage: usage(30_000) });
  await Bun.sleep(5);
  advance(HOUR);
  await wakeDue(desk);
  await wait();
  fake.exit(ref, true, { usage: usage(60_000) });
  await Bun.sleep(5);
  expect(
    desk.db
      .query("select context_used from turn where agent_id = ? order by id")
      .all(id)
  ).toEqual([{ context_used: 30_500 }, { context_used: 60_500 }]);
  expect(
    desk.db
      .query("select context_at_first_call from session where ref = ?")
      .get(ref)
  ).toEqual({ context_at_first_call: 30_000 });
});

test("a first turn that is reminded still sets the session's first call, from its own run", async () => {
  const { desk, fake } = setup();
  const id = await started(desk, "obs_00000000b016");
  const ref = agentOf(desk.db, id)?.session ?? "";
  const usage = (n: number) => ({
    contextFirst: n,
    contextLast: n + 500,
    tokensCached: 0,
    tokensIn: 0,
    tokensOut: 0,
  });
  // Ends with no set_wait: reminded, its run starts later in the conversation.
  fake.exit(ref, true, { usage: usage(30_000) });
  await Bun.sleep(5);
  await setWait(desk, on(desk, id), {
    events: [],
    reason: "r",
    until: ahead(HOUR),
  });
  fake.exit(ref, true, { usage: usage(60_000) });
  await Bun.sleep(5);
  expect(
    desk.db
      .query("select context_at_first_call from session where ref = ?")
      .get(ref)
  ).toEqual({ context_at_first_call: 30_000 });
});
