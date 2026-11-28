import { afterEach, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, HOUR } from "../core/clock";
import { setSettings } from "../core/settings";
import { agentsNow } from "../host/agents-now";
import { projectsWithoutRoomOf, WAITS_FOR_ROOM } from "../host/spending";
import { INSTRUCTIONS, recordInstruction } from "../memory/instructions";
import { register } from "./agent-actions";
import { wakeDue } from "./desk-clock";
import { spendingStopInTurn } from "./spending-stop";
import { ANA, ahead, callDoorOf, on, setup } from "./test-desk";

// A one-off project's quiet line and its cost cap (the owner's decisions of 28 Nov 2026, tickets 31 and 32), over a
// fake runtime and made-up projects.

afterEach(() => {
  rmSync(INSTRUCTIONS, { force: true });
  setSettings({ budget: null });
  setSystemTime();
});

/** His cap on made-up project `project`, as "Build it" records it. */
const cap = (project: string, words: string) =>
  recordInstruction({
    effect: "budget",
    said: `Build it, up to ${words}`,
    scope: `project:${project}`,
    text: `up to ${words}`,
  });

const lineOf = (db: Parameters<typeof agentsNow>[0], id: string) => {
  const a = agentsNow(db, clock().getTime()).find((x) => x.id === id);
  return { doing: a?.doing, eta: a?.eta };
};

test("the quiet line: the door's set_wait and write_notes write it when given `doing` (a new one replaces its eta), keep it when not or when the wait is refused, and the agent's read shows it", async () => {
  const t = setup();
  const id = register(t.desk, {
    brief: "Test: tidy the made-up recipe folder",
    folder: t.dir,
    project: "test-recipes",
    runtime: "fake",
  });
  expect(lineOf(t.desk.db, id)).toEqual({ doing: null, eta: null });
  const eta = ahead(2 * HOUR);
  const wait = { events: [ANA], reason: "the next batch", until: ahead(HOUR) };
  await callDoorOf(t, id, "set_wait", {
    ...wait,
    doing: "Sorting the 2023 recipes",
    eta,
  });
  expect(lineOf(t.desk.db, id)).toEqual({
    doing: "Sorting the 2023 recipes",
    eta,
  });
  // A wait refused (too soon) writes no line.
  await callDoorOf(t, id, "set_wait", {
    ...wait,
    doing: "Refused",
    until: ahead(1000),
  });
  await callDoorOf(t, id, "write_notes", { text: "notes, no line" });
  expect(lineOf(t.desk.db, id).doing).toBe("Sorting the 2023 recipes");
  await callDoorOf(t, id, "write_notes", {
    doing: "Checking the photos",
    text: "notes",
  });
  expect(lineOf(t.desk.db, id)).toEqual({
    doing: "Checking the photos",
    eta: null,
  });
  // The caretaker's work is his complaints: no quiet line, as no notes, on its read.
  const caretaker = register(t.desk, {
    brief: "Test: the caretaker",
    folder: t.dir,
    role: "caretaker",
    runtime: "fake",
    steps: ["obs_000000000001"],
  });
  await callDoorOf(t, caretaker, "write_notes", {
    doing: "Fixing the complaint",
    text: "notes",
  });
  expect(lineOf(t.desk.db, caretaker).doing).toBeNull();
});

test("room: caps add up within the month, oldest first; one that does not fit waits, a smaller later one still fits; no amount, no limit", () => {
  const caps = [
    { at: "2026-11-02T00:00:00.000Z", project: "late", usd: 3 },
    { at: "2026-11-01T00:00:00.000Z", project: "first", usd: 6 },
    { at: "2026-11-01T12:00:00.000Z", project: "big", usd: 5 },
  ];
  expect([...projectsWithoutRoomOf(caps, 10)]).toEqual(["big"]);
  expect([...projectsWithoutRoomOf(caps, undefined)]).toEqual([]);
  // Caps that fit exactly fit, whatever floats say.
  const cents = [
    { at: "2026-11-01T00:00:00.000Z", project: "a", usd: 0.1 },
    { at: "2026-11-02T00:00:00.000Z", project: "b", usd: 0.2 },
  ];
  expect([...projectsWithoutRoomOf(cents, 0.3)]).toEqual([]);
});

test("a capped project's stop counts all its agents' work against its cap; a project with no cap keeps the per-assignment 2%", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const agents = ["first", "second"].map((n) =>
    register(t.desk, {
      brief: `Test: the ${n} agent on the made-up bakery site`,
      folder: t.dir,
      project: "test-bakery",
      runtime: "fake",
    })
  );
  // 1.5 dollars billed on each agent's own assignment; the second one's turn still runs.
  for (const [i, id] of agents.entries()) {
    t.desk.db.run(
      `insert into turn (agent_id, assignment_id, cause, started_at, cost_usd${i === 0 ? ", ended_at" : ""}) values (?, ?, 'first turn', ?, 1.5${i === 0 ? ", ?" : ""})`,
      [
        id,
        on(t.desk, id).id,
        clock().toISOString(),
        ...(i === 0 ? [clock().toISOString()] : []),
      ]
    );
  }
  const second = agents[1] ?? "";
  // No cap: 2% of 100 is 2, and this assignment alone is at 1.5 + 0.4.
  expect(await spendingStopInTurn(t.desk, second, 0.4)).toBeNull();
  cap("test-bakery", "3 dollars");
  // A matter it was handed, with no budget of its own, still answers to the project's cap.
  t.desk.db.run(
    "update assignment set matter_id = 'matter_aaaaaaaaaaaa' where id = ?",
    [on(t.desk, second).id]
  );
  expect(await spendingStopInTurn(t.desk, second, 0.4)).toContain(
    "past its spending stop of 3.00"
  );
});

test("a project whose cap does not fit in the month waits, its quiet line saying so; the one before it starts", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 10 } });
  const [first, second] = ["test-garden", "test-party"].map((project) =>
    register(t.desk, {
      brief: `Test: ${project}`,
      folder: t.dir,
      project,
      runtime: "fake",
    })
  );
  cap("test-garden", "8 dollars");
  setSystemTime(new Date(clock().getTime() + 1000));
  cap("test-party", "5 dollars");
  await wakeDue(t.desk);
  expect(t.turns(first ?? "")).toHaveLength(1);
  expect(t.turns(second ?? "")).toEqual([]);
  expect(lineOf(t.desk.db, second ?? "")).toEqual({
    doing: WAITS_FOR_ROOM,
    eta: null,
  });
});
