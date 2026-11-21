import { afterAll, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../core/files";
import { LIFE_STATE_DIR } from "../core/paths";
import { dayNow } from "../memory/zones";
import { expectWire } from "./http/wire-fixture";
import { matterTurnsOf, readSpending } from "./spending-read";

// `read_spending` on made-up day files of a month long past, today and the month's agents and matters mocked: the
// phone's fixture (`read_spending`).

const DIR = join(LIFE_STATE_DIR, "spending");
afterAll(() => {
  for (const d of ["2020-02-01", "2020-02-03"]) {
    rmSync(join(DIR, `${d}.json`), { force: true });
  }
});
const sum = { billedUsd: 0, calls: 1, equivalentUsd: 0, tokens: 0 };

test("read_spending: a past month's days as held, billed and equivalent apart by provider and kind, today live, unsettled Voice work counted, the top agents and matters by tokens and id", async () => {
  const book = await import("../memory/matters");
  const who = await import("../memory/who");
  const desk = await import("./desk-read");
  const spending = await import("./spending");
  writeJson(join(DIR, "2020-02-01.json"), {
    byKind: [
      { ...sum, billedUsd: 0.25, kind: "night", tokens: 1000 },
      { ...sum, equivalentUsd: 1.5, kind: "agents", tokens: 500_000 },
    ],
    byProvider: [
      {
        ...sum,
        basis: "billed",
        billedUsd: 0.25,
        provider: "openrouter",
        reported: true,
        tokens: 1000,
      },
      {
        ...sum,
        basis: "equivalent",
        equivalentUsd: 1.5,
        provider: "claude",
        reported: true,
        tokens: 500_000,
      },
    ],
    day: "2020-02-01",
    unsettled: 0,
  });
  writeJson(join(DIR, "2020-02-03.json"), {
    byKind: [{ ...sum, billedUsd: 0.1, kind: "voice" }],
    byProvider: [
      {
        ...sum,
        basis: "billed",
        billedUsd: 0.1,
        provider: "elevenlabs",
        reported: false,
      },
    ],
    day: "2020-02-03",
    unsettled: 1,
  });
  const live = spyOn(spending, "readDaySpends").mockResolvedValue({
    spends: [
      {
        at: "2020-02-29T10:00:00.000Z",
        basis: "billed",
        calls: 1,
        kind: "daytime",
        provider: "openrouter",
        reported: true,
        usd: 0.05,
      },
    ],
    unsettled: 0,
  });
  const read = spyOn(desk, "readDesk").mockReturnValue({
    state: "ok",
    value: {
      anchors: [["asg_000000000001", { steps: ["obs_000000000001"] }]],
      names: [
        {
          brief: "Test brief",
          id: "agt_000000000001",
          name: "Test shop agent",
        },
      ],
      turns: [
        {
          agent_id: "agt_000000000001",
          assignment_id: "asg_000000000001",
          // Priced on its own day: a day the price table holds (the desk read is mocked).
          ended_at: "2026-11-10T10:00:00.000Z",
          model: "claude:opus",
          runtime: "claude",
          tokens_cached: 0,
          tokens_in: 400_000,
          tokens_out: 100_000,
        },
      ],
    },
  } as never);
  const matters = spyOn(book, "readMatterBook").mockResolvedValue([
    {
      id: "matter_000000000001",
      name: "Test shop fit-out",
      steps: [{ ref: "obs_000000000001" }],
    },
  ] as never);
  const people = spyOn(who, "readPeople").mockResolvedValue({} as never);
  try {
    const answer = await readSpending("2020-02");
    expect(answer.days.map((d) => d.day)).toEqual(["2020-02-01", "2020-02-03"]);
    expect(answer.month.amount).toBeCloseTo(0.35);
    expect(answer.today.amount).toBe(0.05);
    expect(answer.topMatters).toEqual([
      {
        equivalent: { amount: 3.6, basis: "equivalent", currency: "USD" },
        id: "matter_000000000001",
        matter: "Test shop fit-out",
        reported: true,
        tokens: 500_000,
      },
    ]);
    // A day written with Voice work unsettled: the month says so (a floor).
    expect(answer.unsettled).toBe(1);
    expectWire("read_spending", answer, true);
    // The current month: every day from the 1st to today, each read live while the night has not rolled it up.
    const now = await readSpending();
    expect(now.days.at(-1)?.day).toBe(dayNow());
    expect(now.days.length).toBe(Number(dayNow().slice(8)));
  } finally {
    for (const spy of [live, read, matters, people]) {
      spy.mockRestore();
    }
  }
});

test("a matter's turns are its assignments' whose anchors name it: an anchor shared with another matter goes by the finder's one rule", () => {
  const turn = (assignment_id: string) => ({
    agent_id: "agt_000000000001",
    assignment_id,
    ended_at: "2026-11-10T10:00:00.000Z",
    model: "claude:opus",
    runtime: "claude",
    tokens_cached: 0,
    tokens_in: 100,
    tokens_out: 0,
  });
  const anchors: Record<string, string[]> = {
    asg_000000000001: ["obs_shared", "obs_a"],
    asg_000000000002: ["obs_shared"],
  };
  // The finder: both anchors name A; the shared one alone names B (fewer steps), unless he chose A.
  const find = (refs: readonly string[], prefer?: string) =>
    refs.includes("obs_a") || prefer === "matter_a"
      ? { id: "matter_a", name: "A" }
      : { id: "matter_b", name: "B" };
  const turns = [turn("asg_000000000001"), turn("asg_000000000002")];
  const of = (id: string) =>
    matterTurnsOf(
      turns,
      (a) => ({
        prefer: a === chosen ? "matter_a" : undefined,
        steps: anchors[a] ?? [],
      }),
      find,
      id
    ).map((t) => t.assignment_id);
  let chosen = "";
  expect(of("matter_a")).toEqual(["asg_000000000001"]);
  expect(of("matter_b")).toEqual(["asg_000000000002"]);
  // He chose A for the second: its turns are A's, as the nightly's token rows count them.
  chosen = "asg_000000000002";
  expect(of("matter_a")).toEqual(["asg_000000000001", "asg_000000000002"]);
  expect(of("matter_b")).toEqual([]);
});
