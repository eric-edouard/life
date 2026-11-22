import { expect, test } from "bun:test";
import { spendOfTurn, spendsOf, spendsOfLine, spendsOfVoice } from "./spends";

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

test("a routed call is billed per router, each its own dollars and tokens, the call on the last tried; a router not always priced is not reported, its dollars a floor; a line before routers by its engine's cost", () => {
  const half = { cached: 0, input: 500_000, output: 0 };
  expect(
    spendsOfLine(
      call({
        engine: "openrouter",
        router: "allmodels",
        spentByRouter: {
          allmodels: { costUsd: 0.1, isPriced: true, tokens: half },
          openrouter: { costUsd: 0.25, isPriced: false, tokens: half },
        },
      }),
      "night"
    )
  ).toEqual([
    {
      at: AT,
      basis: "billed",
      calls: 1,
      kind: "night",
      provider: "allmodels",
      reads: { whatsapp: 2 },
      reported: true,
      run: "r1",
      tokens: half,
      usd: 0.1,
    },
    {
      at: AT,
      basis: "billed",
      calls: 0,
      kind: "night",
      provider: "openrouter",
      reported: false,
      tokens: half,
      usd: 0.25,
    },
  ]);
  expect(
    spendsOfLine(call({ costUsd: 0.1, engine: "allmodels" }), "daytime")
  ).toMatchObject([
    { provider: "allmodels", reported: true, tokens, usd: 0.1 },
  ]);
  expect(spendsOfLine(call({ engine: "allmodels" }), "daytime")).toMatchObject([
    { reported: false },
  ]);
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
      call({ engine: "claude", model: "sonnet", tokens: undefined }),
      "daytime"
    )[0]
  ).toMatchObject({ reported: false });
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

test("a turn is its runtime's tokens at its model's list price, its cache reads in its input; a turn from before the column, or with no usage, has none", () => {
  const turn = {
    agent_id: "agt_000000000001",
    assignment_id: "asg_000000000001",
    cost_usd: null,
    ended_at: AT,
    model: "codex:default",
    runtime: "codex",
    tokens_cached: 0,
    tokens_in: 1_000_000,
    tokens_out: null,
  };
  // The desk keeps cache reads apart: 100 in and 1,000 read are 1,100 in, at $2 and $0.10 a million.
  expect(
    spendOfTurn({ ...turn, tokens_cached: 1000, tokens_in: 100 }).equivalentUsd
  ).toBeCloseTo(0.0003);
  const unknown = spendOfTurn({
    ...turn,
    tokens_cached: null,
    tokens_in: null,
  });
  expect(unknown.reported).toBe(false);
  expect(unknown.tokens).toBeUndefined();
  expect(spendOfTurn(turn)).toMatchObject({
    agent: "agt_000000000001",
    basis: "equivalent",
    equivalentUsd: 2,
    kind: "agents",
    provider: "codex",
    reported: true,
  });
  expect(spendOfTurn({ ...turn, model: null })).toMatchObject({
    provider: "codex",
    reported: false,
  });
});

test("a pi turn is billed by OpenRouter: its dollars, or not reported when they did not come", () => {
  const turn = {
    agent_id: "agt_000000000001",
    assignment_id: "asg_000000000001",
    cost_usd: 0.004,
    ended_at: AT,
    model: "pi:flash",
    runtime: "pi",
    tokens_cached: 0,
    tokens_in: 1000,
    tokens_out: 10,
  };
  expect(spendOfTurn(turn)).toMatchObject({
    basis: "billed",
    provider: "openrouter",
    reported: true,
    usd: 0.004,
  });
  expect(spendOfTurn({ ...turn, cost_usd: null })).toMatchObject({
    basis: "billed",
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
    [call({ engine: "openrouter" }), call({ engine: "openrouter", run: "r2" })],
    runs
  ).map((s) => s.kind);
  expect(kinds).toEqual(["night", "daytime"]);
});

test("Voice's spends: a settled job's Scribe seconds at the day's rate, a speech job's own work at $0, a maybe-billed send not reported; a note's seconds; its model runs at list price", () => {
  const spends = spendsOfVoice({
    jobs: [
      {
        at: AT,
        billableSeconds: 3600,
        outcome: "billed",
        seconds: 3000,
        transcriber: "scribe",
      },
      {
        at: AT,
        billableSeconds: 0,
        outcome: "billed",
        seconds: 600,
        transcriber: "speech",
      },
      {
        at: AT,
        billableSeconds: 60,
        outcome: "maybe_billed",
        seconds: 60,
        transcriber: "scribe",
      },
    ],
    modelRuns: [
      {
        at: AT,
        inputTokens: 1_000_000,
        latencyMs: 5,
        model: "claude-sonnet-5-5",
        outputTokens: 0,
        provider: "claude-code",
      },
    ],
    unsettled: 0,
    voiceNotes: [
      { at: AT, billableSeconds: 1800, route: "whole", seconds: 1800 },
      { at: AT, billableSeconds: null, route: null, seconds: null },
    ],
  });
  expect(
    spends.map((s) => [
      s.provider,
      s.basis,
      s.reported,
      s.usd ?? s.equivalentUsd,
    ])
  ).toEqual([
    ["elevenlabs", "billed", true, 0.2],
    ["speech", "billed", true, 0],
    ["elevenlabs", "billed", false, undefined],
    ["elevenlabs", "billed", true, 0.1],
    ["elevenlabs", "billed", false, undefined],
    ["claude", "equivalent", true, 2],
  ]);
  expect(spends.every((s) => s.kind === "voice")).toBe(true);
});
