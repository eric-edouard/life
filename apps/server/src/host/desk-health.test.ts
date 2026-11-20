import { expect, test } from "bun:test";
import type { AgentHold } from "../memory/held-matters";
import { type MatterView, matterFinderOf } from "../memory/matter-read";
import type { HandOutFacts } from "../memory/read-matters";
import type { AgentStatus } from "../records/registered-agent";
import {
  activeOnIdleMatterOf,
  coverageOf,
  decisionOnIdleMatterOf,
  heldByTwoOf,
  lastNeedsYouOf,
  needsYouRowOf,
  splitAnchorsOf,
  stoppedOnRunningOf,
} from "./desk-health";

// The desk health rules, each pure. Made-up matters, agents and decisions.

const matter = (id: string, over: Partial<MatterView> = {}) =>
  ({
    id,
    name: `Matter ${id}`,
    nextStep: { kind: "do", text: "Do it" },
    open: true,
    projects: [],
    status: "moving",
    steps: [{ at: "2026-11-18T09:00:00.000Z", ref: `obs_${id}` }],
    ...over,
  }) as unknown as MatterView;
const running = matter("a");
const done = matter("b", { open: false, status: "done" });
const book = [running, done];
const find = matterFinderOf(book);
const agent = (id: string, status: string, steps: string[]) => ({
  id,
  project: null,
  status,
  steps,
});
const hold = (
  agentId: string,
  step: string,
  over: Partial<AgentHold> = {}
) => ({
  agent: agentId,
  closedAt: null,
  openedBy: "owner" as const,
  outcome: null,
  project: null,
  status: "active" as AgentStatus,
  step,
  whyNotStarted: null,
  ...over,
});

test("an active agent whose matter is not running is an oddity; a stopped one, or one on a running matter, is not", () => {
  expect(
    activeOnIdleMatterOf(
      [
        agent("agt_1", "waiting", ["obs_b"]),
        agent("agt_2", "stopped", ["obs_b"]),
        agent("agt_3", "running", ["obs_a"]),
      ],
      find
    )
  ).toEqual([
    {
      name: "Desk health · agt_1",
      relation: 'active, but its matter "Matter b" is not running',
    },
  ]);
});

test("a matter held by two agents, active or stopped, is an oddity; an ended one does not count", () => {
  const two = heldByTwoOf(book, [
    hold("agt_1", "obs_a"),
    hold("agt_2", "obs_a", { status: "stopped" }),
    hold("agt_3", "obs_b"),
    hold("agt_4", "obs_b", { closedAt: "2026-11-10T09:00:00.000Z" }),
  ]);
  expect(two).toEqual([
    { name: "Desk health · Matter a", relation: "held by agt_1 and agt_2" },
  ]);
});

test("an agent whose anchors no one matter holds all of is an oddity; one ended is not", () => {
  const rows = splitAnchorsOf(
    [
      agent("agt_1", "waiting", ["obs_a", "obs_b"]),
      agent("agt_2", "stopped", ["obs_a"]),
      agent("agt_3", "ended", ["obs_a", "obs_b"]),
      agent("agt_4", "waiting", ["obs_gone"]),
    ],
    find
  );
  expect(rows.map((r) => r.name)).toEqual([
    "Desk health · agt_1",
    "Desk health · agt_4",
  ]);
});

test("a stopped agent on a running matter is an oddity", () => {
  expect(
    stoppedOnRunningOf(
      [
        agent("agt_1", "stopped", ["obs_a"]),
        agent("agt_2", "stopped", ["obs_b"]),
        agent("agt_3", "waiting", ["obs_a"]),
      ],
      find
    ).map((r) => r.name)
  ).toEqual(["Desk health · agt_1"]);
});

test("an open decision on a matter that is not running is an oddity", () => {
  expect(
    decisionOnIdleMatterOf(
      [
        { id: "dec_1", question: "Pay it?", subject: "obs_b" },
        { id: "dec_2", question: "Call?", subject: "obs_a" },
        { id: "dec_3", question: "Why?" },
      ],
      find
    )
  ).toEqual([
    {
      name: "Desk health · dec_1",
      relation: 'open on "Matter b", which is not running: Pay it?',
    },
  ]);
});

test("coverage counts the matters to do and those an active agent holds, then names the first gate each other fails, not_his last", () => {
  const wait = matter("w", { nextStep: { kind: "wait_owner" } as never });
  const ids = (...x: string[]) => new Set(x);
  const matters = ["p", "d", "x", "h", "s", "r", "v"].map((id) => matter(id));
  const HOLDS: Record<string, AgentHold> = {
    h: hold("agt_1", "obs_h"),
    s: hold("agt_2", "obs_s", { status: "stopped" }),
  };
  const facts: HandOutFacts = {
    decisions: [],
    dismissed: ids("x"),
    isDue: (id) => id === "d" || id === "p",
    isHeld: (v) => HOLDS[v.id],
    isHis: (id) => id !== "v",
    isParked: (id) => id === "p",
  };
  const rows = coverageOf([...matters, wait], facts);
  expect(rows).toEqual([
    {
      name: "Agent coverage",
      relation:
        "7 of 8 running matters have a next step to do · 1 held by an active agent",
    },
    { name: "Agent coverage · project parked", relation: "1: Matter p" },
    { name: "Agent coverage · direction due", relation: "1: Matter d" },
    { name: "Agent coverage · dismissed", relation: "1: Matter x" },
    {
      name: "Agent coverage · held by a stopped or ended agent",
      relation: "1: Matter s",
    },
    { name: "Agent coverage · not one of his", relation: "1: Matter v" },
    {
      name: "Agent coverage · ready: waits for the hand-out's pace or his Start",
      relation: "1: Matter r",
    },
  ]);
});

test("the number's row shows last night's only when one was written", () => {
  expect(needsYouRowOf(5)).toEqual({
    name: "Desk health · needs you",
    relation: "5 running matters",
  });
  expect(needsYouRowOf(5, 3).relation).toBe("5 running matters (3 last night)");
  const end = (needsYou?: unknown, step = "memory.nightly") => ({
    kind: "run.end",
    needsYou,
    step,
  });
  expect(lastNeedsYouOf([])).toBeUndefined();
  expect(lastNeedsYouOf([end()])).toBeUndefined();
  expect(lastNeedsYouOf([end(2), end(4, "memory.extract"), end()])).toBe(2);
  expect(lastNeedsYouOf([end(2), end(0)])).toBe(0);
});
