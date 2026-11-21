import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock } from "../core/clock";
import {
  agentOf,
  currentAssignmentOf,
  openTurn,
  turnOf,
} from "../host/desk-read";
import { register } from "./agent-actions";
import { MAX_HANDED } from "./agent-wait";
import { wakeDue } from "./desk-clock";
import { openDesk } from "./desk-store";
import { setup } from "./test-desk";
import { endLostTurns, turnEnded, watch } from "./turn-ends";

// A run's end and its start are bound to its own turn: a late one never touches the turn after it (decision 78's plan,
// rule 4). Made up.

afterEach(() => {
  setSystemTime();
});

/** An agent of the made-up desk with one open turn on its own assignment: its id, its assignment's, the turn's. */
function withTurn(desk: ReturnType<typeof setup>["desk"]) {
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  const s = currentAssignmentOf(desk.db, agent)?.id ?? "";
  const open = () =>
    Number(
      desk.db.run(
        "insert into turn (agent_id, assignment_id, cause, started_at) values (?, ?, 'deadline', ?)",
        [agent, s, clock().toISOString()]
      ).lastInsertRowid
    );
  return { agent, open, s };
}

test("a run that ends late never closes the turn after its own", async () => {
  const { desk } = setup();
  const { open } = withTurn(desk);
  const first = open();
  desk.db.run("update turn set ended_at = ?, outcome = 'waited' where id = ?", [
    clock().toISOString(),
    first,
  ]);
  const next = open();
  await turnEnded(desk, first, { ok: false, why: "Test: late end" });
  expect(turnOf(desk.db, next)?.ended_at).toBeNull();
});

test("a run that begins after its turn was closed counts no event as handed", async () => {
  const { desk } = setup();
  const { open, s } = withTurn(desk);
  desk.db.run(
    "insert into event (assignment_id, event_id, name, payload, received_at) values (?, 'evt_test', 'message.received', '{}', ?)",
    [s, clock().toISOString()]
  );
  const turn = open();
  desk.db.run("update turn set ended_at = ?, outcome = 'failed' where id = ?", [
    clock().toISOString(),
    turn,
  ]);
  const { promise: begun, resolve: begin } = Promise.withResolvers<void>();
  watch(desk, turn, { begun, ended: new Promise(() => undefined) });
  begin();
  await Bun.sleep(0);
  expect(
    desk.db.query<{ handed: number }, []>("select handed from event").get()
      ?.handed
  ).toBe(0);
});

const usageOf = (tokensOut: number) => ({
  contextFirst: null,
  contextLast: null,
  tokensCached: 0,
  tokensIn: 1,
  tokensOut,
});

/** An agent whose first turn's run ends with neither a wait nor `finish` while his app holds its session (#912). */
async function heldAtTheEnd() {
  const made = setup();
  const { desk, fake, queue } = made;
  const agent = register(desk, { brief: "Test brief", runtime: "fake" });
  await wakeDue(desk);
  const turn = openTurn(desk.db, agent)?.id ?? 0;
  queue(agent, "evt_test");
  // Handed to its last try: a turn closed now would drop it.
  desk.db.run("update event set handed = ?", [MAX_HANDED]);
  // The run ends; his app holds the session (it reads as running).
  await turnEnded(desk, turn, { ok: true, usage: usageOf(5) });
  const session = fake.sessions.get(agentOf(desk.db, agent)?.session ?? "");
  const reminders = () =>
    fake.said.filter((m) => m.message.startsWith("Before you stop")).length;
  const release = () => {
    if (session) {
      session.running = false;
    }
  };
  return { ...made, agent, release, reminders, turn };
}

// Regression (#912): a turn that ended with neither while his app held the session lost its reminder, and could drop
// its events.
test("a turn ending with neither while his app holds the session is reminded once, when the session is idle", async () => {
  const { agent, desk, eventRow, release, reminders, turn } =
    await heldAtTheEnd();
  expect(turnOf(desk.db, turn)?.ended_at).toBeNull();
  await endLostTurns(desk);
  expect(reminders()).toBe(0);
  release();
  await endLostTurns(desk);
  await endLostTurns(desk);
  expect(reminders()).toBe(1);
  expect(openTurn(desk.db, agent)?.id).toBe(turn);
  expect(eventRow(agent, "evt_test")?.dropped_at).toBeNull();
});

test("a reminder held by his app survives a restart of the desk", async () => {
  const { agent, desk, eventRow, path, release, reminders } =
    await heldAtTheEnd();
  const restarted = { ...desk, db: openDesk(path) };
  release();
  await endLostTurns(restarted);
  expect(reminders()).toBe(1);
  expect(eventRow(agent, "evt_test")?.dropped_at).toBeNull();
});

test("a reminder held by his app is dropped when he stops the agent: its turn ends with the default wait", async () => {
  const { agent, desk, reminders, turn } = await heldAtTheEnd();
  desk.db.run("update agent set status = 'stopped' where id = ?", [agent]);
  await endLostTurns(desk);
  expect(reminders()).toBe(0);
  expect(turnOf(desk.db, turn)?.outcome).toBe("default_wait");
  expect(turnOf(desk.db, turn)?.ended_at).not.toBeNull();
});

test("a reminder held by his app ends with the agent when its session finishes it", async () => {
  const { agent, desk, reminders, turn } = await heldAtTheEnd();
  desk.db.run("update turn set outcome = 'finished' where id = ?", [turn]);
  desk.db.run("update agent set status = 'ended' where id = ?", [agent]);
  await endLostTurns(desk);
  expect(reminders()).toBe(0);
  expect(turnOf(desk.db, turn)?.outcome).toBe("finished");
  expect(turnOf(desk.db, turn)?.ended_at).not.toBeNull();
});

test("a reminded turn's tokens are both runs'", async () => {
  const { agent, desk, fake, release, turn } = await heldAtTheEnd();
  release();
  await endLostTurns(desk);
  fake.exit(agentOf(desk.db, agent)?.session ?? "", true, {
    usage: usageOf(7),
  });
  await Bun.sleep(0);
  expect(
    desk.db
      .query<{ tokens_out: number }, [number]>(
        "select tokens_out from turn where id = ?"
      )
      .get(turn)?.tokens_out
  ).toBe(12);
});
