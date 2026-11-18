import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDesk } from "./desk-store";

test("openDesk adds turn.begun_at to a store made before it, keeping its rows, its old turns begun when they started", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-desk-")), "desk.sqlite");
  const old = new Database(path);
  old.run(
    "create table turn (id integer primary key, agent_id text not null, session text, cause text not null, started_at text not null, heard_at text, reminded_at text, ended_at text, outcome text, tokens_in integer, tokens_cached integer, tokens_out integer)"
  );
  old.run(
    "insert into turn (agent_id, cause, started_at) values ('agt_000000000001', 'deadline', '2026-11-01T00:00:00.000Z')"
  );
  old.close();
  const db = openDesk(path);
  expect(db.query("select agent_id, begun_at from turn").all()).toEqual([
    { agent_id: "agt_000000000001", begun_at: "2026-11-01T00:00:00.000Z" },
  ]);
  // A second open leaves it be.
  openDesk(path).close();
  db.close();
});

test("openDesk moves an old store's not-started outcomes to agent.why_not_started, keeping an agent's own words as they are", () => {
  const path = join(mkdtempSync(join(tmpdir(), "life-desk-")), "desk.sqlite");
  openDesk(path).close();
  const old = new Database(path);
  old.run("alter table agent drop column why_not_started");
  for (const [id, outcome] of [
    ["agt_000000000001", "not started: claude does not answer"],
    ["agt_000000000002", "Not started: the client never replied"],
    ["agt_000000000003", "done"],
  ]) {
    old.run(
      "insert into agent (id, brief, runtime, folder, status, created_at, ended_at, outcome) values (?, 'b', 'claude', '/', 'ended', '2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', ?)",
      [id as string, outcome as string]
    );
  }
  old.close();
  const db = openDesk(path);
  expect(
    db.query("select id, outcome, why_not_started from agent order by id").all()
  ).toEqual([
    {
      id: "agt_000000000001",
      outcome: null,
      why_not_started: "claude does not answer",
    },
    {
      id: "agt_000000000002",
      outcome: "Not started: the client never replied",
      why_not_started: null,
    },
    { id: "agt_000000000003", outcome: "done", why_not_started: null },
  ]);
  db.close();
});
