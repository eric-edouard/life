import { listUsdOf } from "../core/prices";
import { NONE, type ReadCounts, type Tokens } from "../models/model-call";
import type { Run } from "./run-log";

// Model spending (decision 83): each record that used a paid or metered resource read as one spend, where it is
// logged. A `model.run` line (every model call), a `model.local` line (the describer, Apple's model), a desk turn (an
// agent's), later Voice's rows. Pure; the one reading rule. A spend has one basis, never added to the other:
// `billed`, dollars a provider charges (the local models at $0); `equivalent`, his plans' tokens priced at list.

const SPEND_PROVIDERS = [
  "openrouter",
  "allmodels",
  "elevenlabs",
  "claude",
  "codex",
  "describer",
  "apple",
  "speech",
] as const;
export type SpendProvider = (typeof SPEND_PROVIDERS)[number];
export type Basis = "billed" | "equivalent";
export type SpendKind = "night" | "daytime" | "agents" | "voice";

export interface Spend {
  agent?: string;
  assignment?: string;
  at: string;
  basis: Basis;
  calls: number;
  /** Tokens at list price on its day (`core/prices.ts`), for an `equivalent` spend whose model has a row. */
  equivalentUsd?: number;
  kind: SpendKind;
  ms?: number;
  provider: SpendProvider;
  /** Units read, by source (a model call's `reads`): what `source-use` splits by. */
  reads?: ReadCounts;
  /** False for a billed spend that came without its cost, or an equivalent one with no price: it adds nothing. */
  reported: boolean;
  /** The run it was made in (a model call's). */
  run?: string;
  tokens?: Tokens;
  /** Dollars billed, when reported. */
  usd?: number;
}

const BILLED_ENGINES = new Set(["openrouter", "allmodels"]);
const LOCAL: Record<string, SpendProvider> = {
  describer: "describer",
  foundation: "apple",
};

const num = (v: unknown) => (typeof v === "number" ? v : undefined);
const equivalentOf = (item: string, at: string, tokens: Tokens) => {
  const usd = listUsdOf(item, at.slice(0, 10), tokens);
  return usd === undefined
    ? { reported: false }
    : { equivalentUsd: usd, reported: true };
};

/**
 * One line's spends: a model call's (its engine's, then each other router it tried), a local model's; none for any
 * other line. `kind` is the caller's (`spendsOf`). A billed call's dollars are its routers' own (`costUsdByRouter`; a
 * line before it, `costUsd`, its engine's); a router's null, or a line with neither, is not reported.
 */
export function spendsOfLine(
  e: Record<string, unknown> & { at: string; kind: string },
  kind: SpendKind
): Spend[] {
  if (e.kind === "model.local") {
    const provider = LOCAL[String(e.model)];
    return provider
      ? [
          {
            at: e.at,
            basis: "billed",
            calls: num(e.count) ?? 1,
            kind,
            ms: num(e.ms),
            provider,
            reported: true,
            usd: 0,
          },
        ]
      : [];
  }
  if (e.kind !== "model.run") {
    return [];
  }
  const engine = String(e.engine);
  const tokens = (e.tokens as Tokens | undefined) ?? NONE;
  const call = {
    at: e.at,
    calls: 1,
    kind,
    reads: (e.reads as ReadCounts | undefined) ?? {},
    run: typeof e.run === "string" ? e.run : undefined,
    tokens,
  };
  if (!BILLED_ENGINES.has(engine)) {
    return engine === "claude" || engine === "codex"
      ? [
          {
            ...call,
            basis: "equivalent",
            provider: engine,
            ...equivalentOf(`${engine}:${String(e.model)}`, e.at, tokens),
          },
        ]
      : [];
  }
  const byRouter = e.costUsdByRouter as
    | Record<string, number | null>
    | undefined;
  const usdOf = (router: string) =>
    byRouter ? byRouter[router] : (num(e.costUsd) ?? null);
  const billed = (router: string, usd: number | null | undefined) => ({
    at: e.at,
    basis: "billed" as const,
    provider: router as SpendProvider,
    ...(usd === null ? { reported: false } : { reported: true, usd: usd ?? 0 }),
  });
  return [
    { ...call, ...billed(engine, usdOf(engine)) },
    ...Object.entries(byRouter ?? {})
      .filter(([router]) => router !== engine)
      .map(([router, usd]) => ({ ...billed(router, usd), calls: 0, kind })),
  ];
}

/** A desk turn as a spend reads it (the desk's `turn` row, ended). */
export interface TurnSpent {
  agent_id: string;
  assignment_id: string;
  ended_at: string;
  model: string | null;
  tokens_cached: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

/** An agent's turn: its runtime's tokens, equivalent at its model's list price; one with no model has none. */
export function spendOfTurn(t: TurnSpent): Spend {
  const tokens = {
    cached: t.tokens_cached ?? 0,
    input: t.tokens_in ?? 0,
    output: t.tokens_out ?? 0,
  };
  const runtime = t.model?.split(":")[0];
  return {
    agent: t.agent_id,
    assignment: t.assignment_id,
    at: t.ended_at,
    basis: "equivalent",
    calls: 1,
    kind: "agents",
    provider: runtime === "codex" ? "codex" : "claude",
    tokens,
    ...(t.model
      ? equivalentOf(t.model, t.ended_at, tokens)
      : { reported: false }),
  };
}

/**
 * A window's spends: its lines' (`model.run`, `model.local`), each call's kind by the run it was made in (`runs`,
 * assembled from the same lines: `night` when it sits in a processing run, the one rule `nest` keeps), and the desk's
 * turns ended in it (`agents`).
 */
export function spendsOf(
  lines: (Record<string, unknown> & { at: string; kind: string })[],
  runs: Run[],
  turns: TurnSpent[] = []
): Spend[] {
  const night = new Set(
    runs
      .filter((r) => r.processingRun || r.children)
      .map((r) => r.id.slice(r.step.length + 1))
  );
  return [
    ...lines.flatMap((e) =>
      spendsOfLine(e, night.has(String(e.run)) ? "night" : "daytime")
    ),
    ...turns.map(spendOfTurn),
  ];
}
