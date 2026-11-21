import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { turnsEndedIn } from "../host/desk-turn-reads";
import { SCHEMA } from "./desk-store";

test("a turn's runtime: its model's, else (before turn.model) its session's, each turn once", () => {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  const session = db.query(
    "insert into session (agent_id, runtime, ref, link, started_at) values ('a', ?, ?, '', '2020-01-01')"
  );
  session.run("codex", "s1");
  session.run("codex", "s1");
  session.run("claude", "s2");
  const turn = db.query(
    "insert into turn (agent_id, assignment_id, session, cause, started_at, ended_at, model) values ('a', 'x', ?, 'event', '2020-01-01', ?, ?)"
  );
  turn.run("s1", "2020-01-02T01:00:00.000Z", null);
  turn.run("s2", "2020-01-02T02:00:00.000Z", "codex:gpt");
  turn.run("s2", "2020-01-02T03:00:00.000Z", null);
  turn.run("s2", "2020-01-03T00:00:00.000Z", null);
  expect(
    turnsEndedIn(
      db,
      "2020-01-02T00:00:00.000Z",
      "2020-01-03T00:00:00.000Z"
    ).map((t) => [t.model, t.runtime])
  ).toEqual([
    [null, "codex"],
    ["codex:gpt", null],
    [null, "claude"],
  ]);
});
