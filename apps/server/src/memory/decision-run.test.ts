import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { actorPriceOf, capOf } from "../apify/backend";
import { DAY, HOUR, MIN } from "../core/clock";
import { DECISIONS } from "./decision-lines";
import { answerDecision, decisionsNow, requestDecision } from "./decisions";
import { Need } from "./needs";

// 22 Nov 2026 (his word): an agent may run an Apify actor only on his yes to a card stating it and its cost.
const NOW = new Date("2026-11-18T09:00:00.000Z");
const RUN = {
  actor: "example/places-scraper",
  estimateUsd: 0.09,
  input: { max: 20, query: "dive shop" },
  kind: "apify",
  maxUsd: 0.5,
  what: "20 dive shops with phones",
};
const card = (over = {}) => ({
  context: "Three searches found 4 shops; the scraper lists 20 with phones.",
  deadline: new Date(NOW.getTime() + 2 * DAY).toISOString(),
  needs: [RUN],
  onSilence: null,
  options: [
    { id: "run", label: "Run it", runs: true },
    { id: "no", label: "No" },
  ],
  question: "Use Apify for that, about $0.09?",
  title: "List the dive shops",
  ...over,
});
const token = process.env.APIFY_TOKEN;
beforeEach(() => {
  rmSync(DECISIONS, { force: true });
  process.env.APIFY_TOKEN = "made-up-token";
});
afterEach(() => {
  process.env.APIFY_TOKEN = token;
});

test("an `apify` card is checked when asked: one run with one `runs` option, under its cap, never on silence, only while Apify is connected", async () => {
  const refused = (over: object, why: string) =>
    expect(requestDecision("planner", card(over), NOW)).rejects.toThrow(why);
  await refused(
    { options: [{ id: "x", label: "X" }, card().options[1]] },
    "exactly one `runs`"
  );
  await refused({ onSilence: "run" }, "never takes a `runs`");
  await refused({ needs: [{ ...RUN, estimateUsd: 0.6 }] }, "at most its");
  await refused(
    {
      options: [
        { id: "run", label: "Run it", outgoing: true, runs: true },
        { id: "no", label: "No" },
      ],
    },
    "no other mark"
  );
  expect(Need.safeParse({ ...RUN, maxUsd: 21 }).success).toBe(false);
  expect(Need.safeParse({ ...RUN, actor: "no-slash" }).success).toBe(false);
  delete process.env.APIFY_TOKEN;
  await refused({}, "not connected");
  process.env.APIFY_TOKEN = "made-up-token";
  await requestDecision("planner", card(), NOW);
});

test("his pick of the `runs` option alone starts the run once; his words, a session or a second answer start nothing", async () => {
  const started: string[] = [];
  const run = (d: { id: string }) => {
    started.push(d.id);
    return Promise.resolve("run-1");
  };
  const at = new Date(NOW.getTime() + HOUR);
  const { id } = await requestDecision("planner", card(), NOW);
  await expect(
    answerDecision(id, ["run"], undefined, { now: at })
  ).rejects.toThrow("only on his own answer");
  expect(
    await answerDecision(id, ["run"], undefined, {
      now: at,
      run,
      via: "connector",
    })
  ).toMatchObject([{ kind: "answered" }, { id, kind: "ran", runId: "run-1" }]);
  await expect(
    answerDecision(id, ["run"], undefined, { now: at, run, via: "connector" })
  ).rejects.toThrow("answered");
  const other = await requestDecision("planner", card({ title: "B" }), NOW);
  await answerDecision(other.id, ["run"], "Only 5", {
    now: at,
    run,
    via: "connector",
  });
  expect(started).toEqual([id]);
  expect(decisionsNow(NOW).find((d) => d.id === id)?.ran?.runId).toBe("run-1");
});

test("a start that never ended reads as an error after its limit and is never retried", async () => {
  const { id } = await requestDecision("planner", card(), NOW);
  const hang = Promise.withResolvers<string>();
  const pending = answerDecision(id, ["run"], undefined, {
    now: new Date(NOW.getTime() + HOUR),
    run: () => hang.promise,
    via: "connector",
  });
  const read = decisionsNow(new Date(NOW.getTime() + HOUR + 3 * MIN)).find(
    (d) => d.id === id
  );
  expect(read?.ran?.error).toContain("may have started");
  expect(read?.state).toBe("answered");
  hang.resolve("late");
  await pending;
});

test("an actor's prices are his tier's, and only a pay-per-event actor runs, under a cap it takes", () => {
  const perEvent = actorPriceOf(
    {
      minimalMaxTotalChargeUsd: 0.5,
      pricingModel: "PAY_PER_EVENT",
      pricingPerEvent: {
        actorChargeEvents: {
          "place-scraped": {
            eventTieredPricingUsd: {
              BRONZE: { tieredEventPriceUsd: 0.003 },
              FREE: { tieredEventPriceUsd: 0.004 },
            },
            eventTitle: "Scraped place",
          },
        },
      },
    },
    "BRONZE"
  );
  expect(perEvent).toMatchObject({
    capped: true,
    prices: [{ name: "place-scraped", usd: 0.003 }],
  });
  expect(capOf(perEvent, 1)).toBe(1);
  expect(() => capOf(perEvent, 0.1)).toThrow("at least $0.5");
  expect(() =>
    capOf(actorPriceOf({ pricingModel: "FREE" }, "BRONZE"), 1)
  ).toThrow("can't be held under a dollar cap");
});
