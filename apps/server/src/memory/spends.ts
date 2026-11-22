import { HOUR_PRICES, listUsdOf, priceOn } from "../core/prices";
import type { ReadCounts, Tokens } from "../models/model-call";
import type { RouterSpent } from "../models/routers";
import type { VoiceSpending } from "../sources/lifelog-spending";

// Model spending (decision 83): each record that used a paid or metered resource read as one spend, where it is
// logged. A `model.run` line (every model call), a `model.local` line (the describer, Apple's model), a desk turn (an
// agent's models, and its web searches apart), an Apify run, Voice's rows. Pure; the one reading rule. A spend has one basis, never added to the other:
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
  "apify",
  "web_search",
] as const;
export type SpendProvider = (typeof SPEND_PROVIDERS)[number];
export type Basis = "billed" | "equivalent";

/** Who an agent's turns are spent with, by its runtime: Claude's and Codex's plans, or OpenRouter with Life's key (pi). */
const RUNTIME_PROVIDERS: Partial<Record<string, SpendProvider>> = {
  codex: "codex",
  pi: "openrouter",
};
export const providerOfRuntime = (runtime: string | null): SpendProvider =>
  RUNTIME_PROVIDERS[runtime ?? ""] ?? "claude";
export type SpendKind =
  | "night"
  | "daytime"
  | "agents"
  | "web_search"
  | "apify"
  | "voice";

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

/** An Apify run his yes started (a card's `ran`): what Apify billed for it (`usageTotalUsd`), or not reported while it can't be read. */
export const spendOfApifyRun = (at: string, usd: number | null): Spend => ({
  at,
  basis: "billed",
  calls: 1,
  kind: "apify",
  provider: "apify",
  ...(usd === null ? { reported: false } : { reported: true, usd }),
});

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
 * One line's spends: a model call's (each router it tried, its own dollars and tokens; the call and what it read on
 * `router`, the last tried), a local model's; none for any other line. `kind` is the caller's (`spendsOf`).
 * A router whose tries were not all priced is not reported, its reported dollars a floor; a line before routers
 * (`costUsd`, its engine's) without one is not reported. A call with no tokens is not reported either.
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
  const tokens = e.tokens as Tokens | undefined;
  const call = {
    at: e.at,
    calls: 1,
    kind,
    reads: (e.reads as ReadCounts | undefined) ?? {},
    run: typeof e.run === "string" ? e.run : undefined,
  };
  if (!BILLED_ENGINES.has(engine)) {
    return engine === "claude" || engine === "codex"
      ? [
          {
            ...call,
            basis: "equivalent",
            provider: engine,
            tokens,
            ...(tokens
              ? equivalentOf(`${engine}:${String(e.model)}`, e.at, tokens)
              : { reported: false }),
          },
        ]
      : [];
  }
  const cost = num(e.costUsd);
  const byRouter = Object.entries(
    (e.spentByRouter as Record<string, RouterSpent> | undefined) ?? {
      [engine]: { costUsd: cost ?? 0, isPriced: cost !== undefined, tokens },
    }
  );
  const answeredBy = typeof e.router === "string" ? e.router : engine;
  return byRouter.map(([router, r]) => ({
    at: e.at,
    basis: "billed" as const,
    kind,
    provider: router as SpendProvider,
    reported: r.isPriced,
    tokens: r.tokens,
    usd: r.costUsd,
    ...(router === answeredBy || byRouter.length === 1 ? call : { calls: 0 }),
  }));
}

/** A desk turn as a spend reads it (the desk's `turn` row, ended). */
export interface TurnSpent {
  agent_id: string;
  assignment_id: string;
  /** What its provider billed for its models (pi on OpenRouter); null on a plan's runtime, or a run that came without it. */
  cost_usd: number | null;
  ended_at: string;
  model: string | null;
  /** Its session's runtime: who ran a turn from before `turn.model`. */
  runtime: string | null;
  /** What its web searches cost (pi): 0 with none; null on a plan's runtime, or once a search came without its price. */
  search_usd: number | null;
  tokens_cached: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
}

/** What a turn cost: billed (its dollars, or not reported without them), else equivalent at its model's list price. */
const turnCostOf = (t: TurnSpent, isBilled: boolean, tokens: Tokens | null) => {
  if (isBilled) {
    return t.cost_usd === null
      ? { reported: false }
      : { reported: true, usd: t.cost_usd };
  }
  return t.model && tokens
    ? equivalentOf(t.model, t.ended_at, tokens)
    : { reported: false };
};

/**
 * An agent's turn: its runtime's tokens (the desk keeps cache reads apart from `tokens_in`: input counts them here),
 * billed when its provider is (pi on OpenRouter: its dollars, or not reported without them), else equivalent at its
 * model's list price; one with no model, or no usage, has none.
 */
export function spendOfTurn(t: TurnSpent): Spend {
  const isUsed = t.tokens_in !== null || t.tokens_out !== null;
  const tokens: Tokens = {
    cached: t.tokens_cached ?? 0,
    input: (t.tokens_in ?? 0) + (t.tokens_cached ?? 0),
    output: t.tokens_out ?? 0,
  };
  const provider = providerOfRuntime(t.model?.split(":")[0] ?? t.runtime);
  const isBilled = BILLED_ENGINES.has(provider);
  return {
    agent: t.agent_id,
    assignment: t.assignment_id,
    at: t.ended_at,
    basis: isBilled ? "billed" : "equivalent",
    calls: 1,
    kind: "agents",
    provider,
    ...(isUsed ? { tokens } : {}),
    ...turnCostOf(t, isBilled, isUsed ? tokens : null),
  };
}

/**
 * A turn's spends: its models' (`spendOfTurn`), and its web searches' apart when it ran on a billed runtime (pi) and
 * searched, or a search came without its price (not reported, never guessed).
 */
export function spendsOfTurn(t: TurnSpent): Spend[] {
  const model = spendOfTurn(t);
  if (model.basis !== "billed" || t.tokens_in === null || t.search_usd === 0) {
    return [model];
  }
  return [
    model,
    {
      agent: t.agent_id,
      assignment: t.assignment_id,
      at: t.ended_at,
      basis: "billed",
      calls: 1,
      kind: "web_search",
      provider: "web_search",
      ...(t.search_usd === null
        ? { reported: false }
        : { reported: true, usd: t.search_usd }),
    },
  ];
}

/** Scribe's seconds as a billed spend at its rate on the day; a send that may have been billed (no seconds) is not reported. */
function scribeOf(at: string, billableSeconds: number | null): Spend {
  const rate = priceOn(HOUR_PRICES, "scribe", at.slice(0, 10))?.usdPerHour;
  return {
    at,
    basis: "billed",
    calls: 1,
    kind: "voice",
    provider: "elevenlabs",
    ...(billableSeconds === null || rate === undefined
      ? { reported: false }
      : { reported: true, usd: (billableSeconds / 3600) * rate }),
  };
}

/**
 * Voice's spends (its `GET /spending`): a settled job's Scribe seconds billed and a speech job's own work at $0; a send
 * that may have been billed not reported; a heard note's Scribe seconds; its model runs on his plans, at list price.
 * What is not settled yet is only Voice's count (`unsettled`): its day waits.
 */
export function spendsOfVoice(v: VoiceSpending): Spend[] {
  return [
    ...v.jobs.flatMap((j): Spend[] => {
      const speech: Spend[] =
        j.transcriber === "speech"
          ? [
              {
                at: j.at,
                basis: "billed",
                calls: 1,
                kind: "voice",
                provider: "speech",
                reported: true,
                usd: 0,
              },
            ]
          : [];
      const seconds = j.outcome === "maybe_billed" ? null : j.billableSeconds;
      const scribe = seconds === 0 ? [] : [scribeOf(j.at, seconds)];
      return [...speech, ...scribe];
    }),
    ...v.voiceNotes
      .filter((n) => n.billableSeconds !== 0)
      .map((n) => scribeOf(n.at, n.billableSeconds)),
    ...v.modelRuns.map((r): Spend => {
      const runtime = r.provider === "codex" ? "codex" : "claude";
      // ponytail: Voice keeps no cache split (its input excludes cache reads), so this is an approximation; split cache reads in Voice if it matters.
      const tokens = {
        cached: 0,
        input: r.inputTokens,
        output: r.outputTokens,
      };
      return {
        at: r.at,
        basis: "equivalent",
        calls: 1,
        kind: "voice",
        ms: r.latencyMs ?? undefined,
        provider: runtime,
        tokens,
        ...equivalentOf(`${runtime}:${r.model}`, r.at, tokens),
      };
    }),
  ];
}

/**
 * A window's spends: its lines' (`model.run`, `model.local`), each call's kind by the run it was made in (`runs`,
 * assembled from the same lines: `night` when it sits in a processing run, the one rule `nest` keeps), and the desk's
 * turns ended in it (`agents`).
 */
export function spendsOf(
  lines: (Record<string, unknown> & { at: string; kind: string })[],
  // A run as `assembleRuns` gives it (structural: run-log reads spends).
  runs: {
    children?: unknown;
    id: string;
    processingRun?: unknown;
    step: string;
  }[],
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
    ...turns.flatMap(spendsOfTurn),
  ];
}
