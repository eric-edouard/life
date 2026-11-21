import { expect, test } from "bun:test";
import { spendOfTurn, spendsOf, spendsOfLine } from "./spends";

const AT = "2026-11-21T10:00:00.000Z";
const tokens = { cached: 0, input: 1_000_000, output: 0 };
const call = (more: Record<string, unknown>) => ({
  at: AT,
  kind: "model.run",
  reads: { whatsapp: 2 },
  run: "r1",
  tokens,
  ...more,
});

test("a routed call is billed per router: its engine's with its tokens, another router tried on its own; null is not reported; a line before routers by its engine's cost", () => {
  expect(
    spendsOfLine(
      call({
        costUsdByRouter: { allmodels: null, openrouter: 0.25 },
        engine: "openrouter",
      }),
      "night"
    )
  ).toEqual([
    {
      at: AT,
      basis: "billed",
      calls: 1,
      kind: "night",
      provider: "openrouter",
      reads: { whatsapp: 2 },
      reported: true,
      run: "r1",
      tokens,
      usd: 0.25,
    },
    {
      at: AT,
      basis: "billed",
      calls: 0,
      kind: "night",
      provider: "allmodels",
      reported: false,
    },
  ]);
  expect(
    spendsOfLine(call({ costUsd: 0.1, engine: "allmodels" }), "daytime")[0]
  ).toMatchObject({ provider: "allmodels", reported: true, usd: 0.1 });
  expect(
    spendsOfLine(call({ engine: "allmodels" }), "daytime")[0]
  ).toMatchObject({ reported: false });
  // A call that no router answered billed nothing.
  expect(
    spendsOfLine(call({ costUsdByRouter: {}, engine: "openrouter" }), "daytime")
  ).toMatchObject([{ reported: true, usd: 0 }]);
});

test("a subscription call is its tokens at list price, never billed; a model with no price is not reported; the local models are billed at $0", () => {
  expect(
    spendsOfLine(call({ engine: "claude", model: "sonnet" }), "daytime")[0]
  ).toMatchObject({ basis: "equivalent", equivalentUsd: 2, reported: true });
  expect(
    spendsOfLine(call({ engine: "codex", model: "made-up" }), "daytime")[0]
  ).toMatchObject({ basis: "equivalent", reported: false });
  expect(
    spendsOfLine(
      { at: AT, count: 3, kind: "model.local", model: "foundation", ms: 900 },
      "daytime"
    )
  ).toEqual([
    {
      at: AT,
      basis: "billed",
      calls: 3,
      kind: "daytime",
      ms: 900,
      provider: "apple",
      reported: true,
      usd: 0,
    },
  ]);
  expect(spendsOfLine({ at: AT, kind: "run.start" }, "daytime")).toEqual([]);
});

test("a turn is its runtime's tokens at its model's list price; a turn from before the column has none", () => {
  const turn = {
    agent_id: "agt_000000000001",
    assignment_id: "asg_000000000001",
    ended_at: AT,
    model: "codex:default",
    tokens_cached: 0,
    tokens_in: 1_000_000,
    tokens_out: null,
  };
  expect(spendOfTurn(turn)).toMatchObject({
    agent: "agt_000000000001",
    basis: "equivalent",
    equivalentUsd: 2,
    kind: "agents",
    provider: "codex",
    reported: true,
  });
  expect(spendOfTurn({ ...turn, model: null })).toMatchObject({
    provider: "claude",
    reported: false,
  });
});

test("a call made in a processing run's step is the night's; any other the daytime's", () => {
  const runs = [
    {
      children: ["memory.extract/r1"],
      id: "memory.nightly/n1",
      step: "memory.nightly",
    },
    {
      id: "memory.extract/r1",
      processingRun: "memory.nightly/n1",
      step: "memory.extract",
    },
    { id: "memory.files/r2", step: "memory.files" },
  ] as Parameters<typeof spendsOf>[1];
  const kinds = spendsOf(
    [
      call({ costUsdByRouter: {}, engine: "openrouter" }),
      call({ costUsdByRouter: {}, engine: "openrouter", run: "r2" }),
    ],
    runs
  ).map((s) => s.kind);
  expect(kinds).toEqual(["night", "daytime"]);
});
