import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDesk } from "./desk-store";

test("openDesk adds turn.begun_at to a store made before it, keeping its rows", () => {
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
    { agent_id: "agt_000000000001", begun_at: null },
  ]);
  // A second open leaves it be.
  openDesk(path).close();
  db.close();
});
