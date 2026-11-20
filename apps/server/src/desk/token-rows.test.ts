import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { tokensSince } from "../host/desk-read";
import { readAgentRows, tokenRowsOf } from "../host/registered-agents";
import { openDesk } from "./desk-store";

// The nightly report's token rows: turns summed by his local day and by matter, from made-up turns. The test zones
// have him in Jakarta (UTC+7) until 6 Oct 2026.

rmSync(dirname(DESK_STORE), { force: true, recursive: true });
setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
afterAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  setSettings({ desk: null });
});

const turn = (
  agent_id: string,
  started_at: string,
  i: number,
  c = 0,
  o = 0
) => ({
  agent_id,
  started_at,
  tokens_cached: c,
  tokens_in: i,
  tokens_out: o,
});

test("tokens are summed by his local day: 23:30 UTC is already the next day in Jakarta", () => {
  const rows = tokenRowsOf(
    [
      turn("a", "2026-09-10T10:00:00.000Z", 100, 40, 10),
      turn("a", "2026-09-10T23:30:00.000Z", 200, 0, 20),
      turn("b", "2026-09-10T11:00:00.000Z", 1),
    ],
    (id) => (id === "a" ? "Test bakery order" : "no matter")
  );
  expect(rows).toEqual([
    { name: "Tokens · 2026-09-10", relation: "101 in (40 cached) · 10 out" },
    { name: "Tokens · 2026-09-11", relation: "200 in (0 cached) · 20 out" },
    {
      name: "Tokens · Test bakery order",
      relation: "300 in (40 cached) · 30 out",
    },
    { name: "Tokens · no matter", relation: "1 in (0 cached) · 0 out" },
  ]);
});

test("the turns since the last report, a running turn counting 0, reach the nightly rows", async () => {
  const db = openDesk();
  const run = (
    agent: string,
    at: string,
    tokens: [number, number, number] | null
  ) =>
    db.run(
      "insert into turn (agent_id, cause, started_at, tokens_in, tokens_cached, tokens_out) values (?, 'start', ?, ?, ?, ?)",
      [agent, at, ...(tokens ?? [null, null, null])]
    );
  run("agt_old", "2026-09-09T10:00:00.000Z", [5, 0, 5]);
  run("agt_one", "2026-09-10T10:00:00.000Z", [7, 3, 2]);
  run("agt_one", "2026-09-10T12:00:00.000Z", null);
  const since = "2026-09-10T00:00:00.000Z";
  expect(tokensSince(db, since).map((t) => t.tokens_in)).toEqual([7, 0]);
  const rows = await readAgentRows(since);
  expect(rows).toContainEqual({
    name: "Tokens · 2026-09-10",
    relation: "7 in (3 cached) · 2 out",
  });
  expect(rows).toContainEqual({
    name: "Tokens · no matter",
    relation: "7 in (3 cached) · 2 out",
  });
});
