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

const turn = (agent_id: string, ended_at: string, i: number, c = 0, o = 0) => ({
  agent_id,
  ended_at,
  tokens_cached: c,
  tokens_in: i,
  tokens_out: o,
});

test("tokens are summed by his local day of the turn's end: 23:30 UTC is the next day in Jakarta; matters are keyed by id", () => {
  const bakery = { id: "matter_1", name: "Test bakery order" };
  const rows = tokenRowsOf(
    [
      turn("a", "2026-09-10T10:00:00.000Z", 100, 40, 10),
      turn("a", "2026-09-10T23:30:00.000Z", 200, 0, 20),
      turn("b", "2026-09-10T11:00:00.000Z", 1),
      turn("c", "2026-09-10T11:00:00.000Z", 2),
    ],
    (id) =>
      id === "a"
        ? bakery
        : id === "b"
          ? { id: "matter_2", name: "Test bakery order" }
          : undefined
  );
  expect(rows).toEqual([
    { name: "Tokens · 2026-09-10", relation: "103 in (40 cached) · 10 out" },
    { name: "Tokens · 2026-09-11", relation: "200 in (0 cached) · 20 out" },
    { name: "Tokens · no matter", relation: "2 in (0 cached) · 0 out" },
    {
      name: "Tokens · Test bakery order",
      relation: "300 in (40 cached) · 30 out",
    },
    { name: "Tokens · Test bakery order", relation: "1 in (0 cached) · 0 out" },
  ]);
});

test("a turn running across a report is not listed; once ended it shows in the next window", async () => {
  const db = openDesk();
  const run = (
    agent: string,
    ended: string | null,
    tokens: [number, number, number]
  ) =>
    db.run(
      "insert into turn (agent_id, cause, started_at, ended_at, tokens_in, tokens_cached, tokens_out) values (?, 'start', '2026-09-09T10:00:00.000Z', ?, ?, ?, ?)",
      [agent, ended, ...tokens]
    );
  run("agt_old", "2026-09-09T11:00:00.000Z", [5, 0, 5]);
  run("agt_one", "2026-09-10T10:00:00.000Z", [7, 3, 2]);
  run("agt_one", null, [0, 0, 0]);
  const since = "2026-09-10T00:00:00.000Z";
  expect(tokensSince(db, since).map((t) => t.tokens_in)).toEqual([7]);
  const rows = await readAgentRows(since);
  expect(rows).toContainEqual({
    name: "Tokens · 2026-09-10",
    relation: "7 in (3 cached) · 2 out",
  });
  expect(rows).toContainEqual({
    name: "Tokens · no matter",
    relation: "7 in (3 cached) · 2 out",
  });
  // The running turn ends after that report: the next window holds it.
  db.run(
    "update turn set ended_at = '2026-09-11T10:00:00.000Z', tokens_in = 9 where ended_at is null"
  );
  expect(
    tokensSince(db, "2026-09-10T10:00:00.000Z").map((t) => t.tokens_in)
  ).toEqual([9]);
});
