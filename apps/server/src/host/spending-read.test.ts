import { afterAll, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { writeJson } from "../core/files";
import { LIFE_STATE_DIR } from "../core/paths";
import { dayNow } from "../memory/zones";
import { expectWire } from "./http/wire-fixture";
import { readSpending } from "./spending-read";

// `read_spending` on made-up day files of a month long past, today and the month's agents and matters mocked: the
// phone's fixture (`read_spending`).

const DIR = join(LIFE_STATE_DIR, "spending");
afterAll(() => {
  for (const d of ["2020-02-01", "2020-02-03"]) {
    rmSync(join(DIR, `${d}.json`), { force: true });
  }
});
const sum = { billedUsd: 0, calls: 1, equivalentUsd: 0, tokens: 0 };

test("read_spending: a past month's days as held, billed and equivalent apart by provider and kind, today live, the top agents and matters by tokens", async () => {
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
    unsettled: 0,
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
      anchors: [["asg_000000000001", ["obs_000000000001"]]],
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
        matter: "Test shop fit-out",
        tokens: 500_000,
      },
    ]);
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
