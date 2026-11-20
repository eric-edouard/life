import { afterEach, beforeEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY, HOUR, iso, MIN } from "../core/clock";
import { setSettings, settings } from "../core/settings";
import { agentOf } from "../host/desk-read";
import { decisionsNow } from "../memory/decisions";
import { dayNow, dayStart, zoneNow } from "../memory/zones";
import {
  askDecision,
  readPacket,
  register,
  withdrawOpenDecision,
} from "./agent-actions";
import { wakeDue } from "./desk-clock";
import { NO_CARD_OUTCOME } from "./hand-out";
import { endAgentsWithoutCard, handOutNext } from "./hand-out-tick";
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
  { id: "mat_a", projects: [], steps: ["obs_a1"] },
  { id: "mat_b", projects: [], steps: ["obs_b1"] },
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

test("a blocked default runtime starts nothing, and the look still counts", async () => {
  const t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  t.fake.blocked = "Test: not logged in";
  const { read, reads } = book();
  expect(await handOutNext(t.desk, read)).toBeUndefined();
  expect(reads.n).toBe(0);
  t.fake.blocked = undefined;
  setSystemTime(new Date(clock().getTime() + 9 * MIN));
  expect(await handOutNext(t.desk, read)).toBeUndefined();
  setSystemTime(new Date(clock().getTime() + 2 * MIN));
  expect(await handOutNext(t.desk, read)).toBeTruthy();
});

test("the daily count follows his day: a hand-out before his day began is not counted", async () => {
  setSettings({
    desk: {
      defaultRuntime: "claude",
      handOut: { aDay: 1, cardsWaiting: 1000 },
      runtimes: {},
    },
  });
  const desk = deskOf();
  const { read, reads } = book();
  const old = register(desk, { brief: "Test brief", runtime: "claude" });
  const since = dayStart(dayNow(), zoneNow());
  const markAt = (id: string, at: number) =>
    desk.db.run(
      "update agent set is_handed_out = 1, created_at = ? where id = ?",
      [new Date(at).toISOString(), id]
    );
  markAt(old, since.getTime() - MIN);
  expect(await handOutNext(desk, read)).toBeTruthy();
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  expect(await handOutNext(desk, read)).toBeUndefined();
  expect(reads.n).toBe(1);
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
  const plain = register(desk, {
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

// The give-back: a handed-out agent that asked no card in time is ended.

const handedOut = async (desk: ReturnType<typeof deskOf>) => {
  const id = (await handOutNext(desk, book().read)) ?? "";
  await wakeDue(desk);
  desk.db.run("update turn set begun_at = ? where agent_id = ?", [
    clock().toISOString(),
    id,
  ]);
  return id;
};
const cardOf = (desk: ReturnType<typeof deskOf>, id: string) =>
  askDecision(desk, id, {
    deadline: iso(clock().getTime() + DAY),
    options: [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ],
    question: "Test: send this?",
    title: "a test",
  });

test("a card asked in time keeps the agent; none at 2 hours ends it with its outcome and stops its run", async () => {
  const t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  const { desk } = t;
  const asked = await handedOut(desk);
  cardOf(desk, asked);
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  const silent = await handedOut(desk);
  setSystemTime(new Date(clock().getTime() + 2 * HOUR));
  await endAgentsWithoutCard(desk);
  expect(agentOf(desk.db, asked)?.status).toBe("active");
  const a = agentOf(desk.db, silent);
  expect(a?.status).toBe("ended");
  expect(a?.outcome).toBe(NO_CARD_OUTCOME);
  expect(t.fake.stopped).toEqual([a?.session ?? ""]);
  await withdrawOpenDecision(asked, "test over");
});

test("an agent he started himself is never ended for asking no card", async () => {
  const desk = deskOf();
  const id = register(desk, { brief: "Test brief", runtime: "claude" });
  await wakeDue(desk);
  desk.db.run("update turn set begun_at = ? where agent_id = ?", [
    clock().toISOString(),
    id,
  ]);
  setSystemTime(new Date(clock().getTime() + 3 * HOUR));
  await endAgentsWithoutCard(desk);
  expect(agentOf(desk.db, id)?.status).toBe("active");
});

test("a hand-out whose first turn never began is not picked again", async () => {
  const desk = deskOf();
  const { read } = book();
  const first = (await handOutNext(desk, read)) ?? "";
  desk.db.run(
    "update agent set status = 'ended', ended_at = ?, why_not_started = 'test' where id = ?",
    [clock().toISOString(), first]
  );
  setSystemTime(new Date(clock().getTime() + 11 * MIN));
  const second = (await handOutNext(desk, read)) ?? "";
  const steps = (id: string) =>
    desk.db
      .query<{ step: string }, [string]>(
        "select step from anchor where agent_id = ?"
      )
      .all(id)
      .map((r) => r.step);
  expect(steps(first)).toEqual(["obs_a1"]);
  expect(steps(second)).toEqual(["obs_b1"]);
});

test("the 2 hours run from the first turn's beginning, not the agent's creation", async () => {
  const desk = deskOf();
  const id = (await handOutNext(desk, book().read)) ?? "";
  setSystemTime(new Date(clock().getTime() + HOUR));
  await wakeDue(desk);
  desk.db.run("update turn set begun_at = ? where agent_id = ?", [
    clock().toISOString(),
    id,
  ]);
  setSystemTime(new Date(clock().getTime() + HOUR + 30 * MIN));
  await endAgentsWithoutCard(desk);
  expect(agentOf(desk.db, id)?.status).toBe("active");
  setSystemTime(new Date(clock().getTime() + 31 * MIN));
  await endAgentsWithoutCard(desk);
  expect(agentOf(desk.db, id)?.status).toBe("ended");
});
