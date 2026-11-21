import { expect, test } from "bun:test";
import type { AgentHold } from "../memory/held-matters";
import { type MatterView, matterFinderOf } from "../memory/matter-read";
import type { HandOutFacts } from "../memory/read-matters";
import type { AgentStatus } from "../records/registered-agent";
import { Organization, Person } from "../records/truth";
import {
  activeOnIdleMatterOf,
  coverageOf,
  decisionOnIdleMatterOf,
  heldByTwoOf,
  lastNeedsYouOf,
  needsYouRowOf,
  peopleRowsOf,
  splitAnchorsOf,
  stoppedOnRunningOf,
} from "./desk-health";

// The desk health rules, each pure. Made-up matters, agents, decisions and people.

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

test("coverage counts the matters to do and those an active agent holds, then names the first gate each other fails, no_agent last", () => {
  const wait = matter("w", { nextStep: { kind: "wait_owner" } as never });
  const ids = (...x: string[]) => new Set(x);
  const matters = ["p", "d", "x", "h", "s", "r", "v", "n"].map((id) =>
    matter(id)
  );
  const HOLDS: Record<string, AgentHold> = {
    h: hold("agt_1", "obs_h"),
    s: hold("agt_2", "obs_s", { status: "stopped" }),
  };
  const facts: HandOutFacts = {
    agentFor: (v) => (v.id === "n" ? undefined : "agt_1"),
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
        "8 of 9 running matters have a next step to do · 1 held by an active agent",
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
      name: "Agent coverage · no agent takes it: no agent of its project, no Personal agent",
      relation: "1: Matter n",
    },
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

// Verdict on PR 841: the health rules found an agent's matter from its steps alone, so an agent on the running matter
// he chose, sharing its step with a done one, read as idle. Each rule takes the chosen matter on a tie.
test("an agent on the matter he chose, sharing its step with a done one, is at work; a card on it is not on an idle matter", () => {
  const shared = [
    { at: "2026-11-18T09:00:00.000Z", ref: "obs_shared" },
  ] as unknown as MatterView["steps"];
  const tied = matterFinderOf([
    matter("over", { open: false, status: "done", steps: shared }),
    matter("chosen", { steps: shared }),
  ]);
  const on = {
    ...agent("agt_1", "waiting", ["obs_shared"]),
    matter: { id: "chosen" },
  };
  expect(activeOnIdleMatterOf([on], tied)).toEqual([]);
  expect(splitAnchorsOf([on], tied)).toEqual([]);
  expect(
    decisionOnIdleMatterOf(
      [
        {
          id: "dec_1",
          matter: "chosen",
          question: "Go?",
          subject: "obs_shared",
        },
      ],
      tied
    )
  ).toEqual([]);
  // With no matter chosen, the done one is found: the oddity the pick prevents.
  expect(activeOnIdleMatterOf([{ ...on, matter: null }], tied)).toHaveLength(1);
});

test("the people rows: a guess with no live evidence, a changed person with no handle, a changed organization with nobody, a link whose year ran out since the last night or that changed and has", () => {
  const truth = {
    organizations: [
      Organization.parse({ id: "acme", name: "Acme", people: [] }),
      Organization.parse({
        id: "bolt",
        name: "Bolt",
        people: [
          { id: "ann", role: "Founder" },
          { id: "bob", role: "Engineer" },
          { id: "cid", role: "Engineer" },
          { id: "dan", role: "Engineer", until: 2024 },
          { id: "eve", role: "Engineer" },
        ],
      }),
    ],
    people: [
      Person.parse({ id: "me", name: "Jean" }),
      Person.parse({ id: "ann", name: "Ann" }),
      Person.parse({
        handles: { phone: ["+66600000009"] },
        id: "bob",
        name: "Bob",
      }),
      Person.parse({ id: "cid", name: "Cid" }),
      Person.parse({ id: "dan", name: "Dan" }),
      Person.parse({ id: "eve", name: "Eve" }),
    ],
  };
  const last: Record<string, string> = {
    // Its year ran out today, after the last night's day.
    ann: "2025-11-21",
    // Long ago, and nothing about the link changed: shown the night it ran out, not again.
    bob: "2024-01-01",
    // Ended, by his word: never shown.
    dan: "2020-01-01",
    // Within the year.
    eve: "2026-03-01",
  };
  const input = {
    changed: new Set(["acme", "ann", "bob", "bolt|cid", "bolt|eve", "me"]),
    guesses: [
      { evidence: ["unit_gone"], id: "inf_x", name: "X" },
      { evidence: ["unit_gone", "unit_live"], id: "inf_y", name: "Y" },
    ],
    lastExchangeDay: (id: string) => last[id],
    live: new Set(["unit_live"]),
    sinceDay: "2026-11-20",
    today: "2026-11-21",
    truth,
  };
  const rows = peopleRowsOf(input).map((r) => `${r.name}: ${r.relation}`);
  expect(rows).toEqual([
    "People · X: a guess (inf_x) with no evidence left",
    "People · Ann: in his directory with no handle",
    "People · Acme: an organization with nobody linked",
    "People · Ann: at Bolt: no counted exchange in a year, and the link has no end",
    "People · Cid: at Bolt: no counted exchange in a year, and the link has no end",
  ]);
  // No counts tonight: nothing is said of the links.
  expect(peopleRowsOf({ ...input, lastExchangeDay: null })).toHaveLength(3);
});
