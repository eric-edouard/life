import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY, iso, MIN } from "../core/clock";
import { setSettings, settings } from "../core/settings";
import { agentOf } from "../host/desk-read";
import { decisionsNow } from "../memory/decisions";
import { askDecision, readPacket, withdrawOpenDecision } from "./agent-actions";
import { handOutNext } from "./hand-out-tick";
import { setup } from "./test-desk";

// The hand-out's step of the tick, over a fake runtime and a made-up book of matters.

const was = settings().desk;
beforeEach(() => {
  setSettings({
    desk: {
      defaultRuntime: "claude",
      handOut: { aDay: 2, cardsWaiting: 1000 },
      runtimes: {},
    },
  });
});
afterEach(() => {
  setSettings({ desk: was ?? null });
  setSystemTime();
});

const MATTERS = [
  { id: "mat_a", name: "Test repair", projects: [], steps: ["obs_a1"] },
  { id: "mat_b", name: "Test order", projects: [], steps: ["obs_b1"] },
];
const book = () => {
  const reads = { n: 0 };
  return {
    read: () => {
      reads.n += 1;
      return Promise.resolve({
        dismissed: [],
        matters: MATTERS,
        offered: new Set<string>(),
      });
    },
    reads,
  };
};
const deskOf = () => {
  const t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  return t.desk;
};
const agentsOf = (desk: ReturnType<typeof deskOf>) =>
  desk.db
    .query<{ id: string; is_handed_out: number; brief: string }, []>(
      "select id, is_handed_out, brief from agent order by rowid"
    )
    .all();

test("one agent starts on the top matter, marked handed out, and none again within 10 minutes", async () => {
  const desk = deskOf();
  const { read, reads } = book();
  const id = await handOutNext(desk, read);
  expect(id).toBeTruthy();
  expect(agentsOf(desk)).toHaveLength(1);
  expect(agentsOf(desk)[0]?.is_handed_out).toBe(1);
  const anchored = desk.db
    .query<{ step: string }, [string]>(
      "select step from anchor where agent_id = ?"
    )
    .all(id ?? "");
  expect(anchored).toEqual([{ step: "obs_a1" }]);
  setSystemTime(new Date(clock().getTime() + 9 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(1);
  setSystemTime(new Date(clock().getTime() + 2 * MIN));
  // The first matter is held now: the next look takes the second.
  const second = await handOutNext(desk, read);
  expect(second).toBeTruthy();
  expect(agentsOf(desk)).toHaveLength(2);
});

test("with no setting the hand-out is off and reads nothing", async () => {
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
  const desk = deskOf();
  const { read, reads } = book();
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(0);
  expect(agentsOf(desk)).toHaveLength(0);
});

test("a look under the daily cap reads no matter book", async () => {
  const desk = deskOf();
  const { read, reads } = book();
  await handOutNext(desk, read);
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  await handOutNext(desk, read);
  expect(agentsOf(desk)).toHaveLength(2);
  const before = reads.n;
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(before);
});

test("a look under the cards cap reads no matter book", async () => {
  const desk = deskOf();
  const { read, reads } = book();
  const open = () =>
    decisionsNow().filter((d) => d.state === "open" && d.agent).length;
  setSettings({
    desk: {
      defaultRuntime: "claude",
      handOut: { aDay: 5, cardsWaiting: open() + 1 },
      runtimes: {},
    },
  });
  const id = await handOutNext(desk, read);
  askDecision(desk, id ?? "", {
    deadline: iso(clock().getTime() + DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: send this?",
    title: "a test",
  });
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(1);
  await withdrawOpenDecision(id ?? "", "test over");
});

test("a handed-out agent's packet carries the one-card first turn, a plain agent's the plan", async () => {
  const desk = deskOf();
  const handed = await handOutNext(desk, book().read);
  const plain = (await import("./agent-actions")).register(desk, {
    brief: "Test brief",
    runtime: "claude",
  });
  const one = await readPacket(desk, handed ?? "", false);
  const two = await readPacket(desk, plain, false);
  expect(one).toContain("Life handed you this matter");
  expect(one).not.toContain("Start with this plan?");
  expect(two).toContain("Start with this plan?");
  expect(two).not.toContain("Life handed you this matter");
  expect(agentOf(desk.db, handed ?? "")?.is_handed_out).toBe(1);
});
