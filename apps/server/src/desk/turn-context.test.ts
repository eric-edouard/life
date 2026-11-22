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

test("a reminded turn's billed cost adds up over its runs, and stays none once a run came without it", async () => {
  const billedOver = async (obs: string, runs: (number | null)[]) => {
    const { desk, fake } = setup();
    const id = await started(desk, obs);
    const ref = agentOf(desk.db, id)?.session ?? "";
    for (const [i, billedUsd] of runs.entries()) {
      if (i === runs.length - 1) {
        // biome-ignore lint/performance/noAwaitInLoops: the last run sets its wait, the earlier are reminded
        await setWait(desk, on(desk, id), {
          events: [],
          reason: "r",
          until: ahead(HOUR),
        });
      }
      fake.exit(ref, true, {
        usage: {
          billedUsd,
          contextFirst: 1,
          contextLast: 1,
          tokensCached: 0,
          tokensIn: 1,
          tokensOut: 1,
        },
      });
      await Bun.sleep(5);
    }
    return desk.db
      .query("select cost_usd from turn where agent_id = ?")
      .get(id);
  };
  expect(await billedOver("obs_00000000b017", [0.1, 0.2])).toEqual({
    cost_usd: expect.closeTo(0.3),
  });
  expect(await billedOver("obs_00000000b018", [null, 0.2])).toEqual({
    cost_usd: null,
  });
  expect(await billedOver("obs_00000000b019", [0.1, null])).toEqual({
    cost_usd: null,
  });
});
