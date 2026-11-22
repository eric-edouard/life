import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { failedInARowOf, waitingSinceOf } from "../host/agents-now";
import { openDesk } from "./desk-store";

// What the agents' health reads from the desk's store, on made-up rows: the oldest event no turn was handed (handed,
// consumed, dropped and closed assignments' left out), and the failed turns in a row, stopping at the first that was not.

test("waiting since its oldest unheard event; failures in a row up to the first that was not", () => {
  const db = openDesk(
    join(mkdtempSync(join(tmpdir(), "life-health-")), "d.sqlite")
  );
  const at = (h: number) => `2026-11-22T0${h}:00:00.000Z`;
  for (const [id, closed] of [
    ["asg_open", null],
    ["asg_closed", at(1)],
  ] as const) {
    db.run(
      "insert into assignment (id, agent_id, opened_at, opened_by, notes_path, wait_until, closed_at) values (?, 'agt_a', ?, 'owner', '', ?, ?)",
      [id, at(1), at(1), closed]
    );
  }
  const event = (s: string, id: string, h: number, extra = "") =>
    db.run(
      `insert into event (assignment_id, event_id, name, payload, received_at${extra ? `, ${extra}` : ""}) values (?, ?, 'message.received', '{}', ?${extra ? ", 1" : ""})`,
      [s, id, at(h)]
    );
  expect(waitingSinceOf(db, "agt_a")).toBeNull();
  event("asg_closed", "e1", 1);
  event("asg_open", "e2", 2, "handed");
  event("asg_open", "e3", 3);
  event("asg_open", "e4", 4);
  expect(waitingSinceOf(db, "agt_a")).toBe(at(3));
  const turn = (outcome: string) =>
    db.run(
      "insert into turn (agent_id, assignment_id, cause, started_at, ended_at, outcome) values ('agt_a', 'asg_open', 'event', ?, ?, ?)",
      [at(5), at(5), outcome]
    );
  turn("failed");
  turn("waited");
  expect(failedInARowOf(db, "agt_a")).toBe(0);
  turn("failed");
  turn("failed");
  expect(failedInARowOf(db, "agt_a")).toBe(2);
});
