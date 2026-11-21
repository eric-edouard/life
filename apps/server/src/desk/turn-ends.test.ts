import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock } from "../core/clock";
import { currentAssignmentOf, turnOf } from "../host/desk-read";
import { register } from "./agent-actions";
import { setup } from "./test-desk";
import { turnEnded, watch } from "./turn-ends";

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
