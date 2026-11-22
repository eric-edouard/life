import { clock, iso } from "./clock";

// The one price table, for Life and Voice alike: nothing else in either app holds a price. A row holds from its day
// (`from`, a UTC day) until a later row of its item; `priceOn` takes the latest on or before a spend's day. Each row
// cites its page and the day it was read: `from` is the first day it is evidenced, and a day before every row of an
// item has no price (not reported). A price only ever prices what was used: a billed call that came without its cost is
// not reported, never guessed from here. ponytail: equivalents use the standard short-context rates (no cache-write or
// long-prompt rates: the usage kept can't tell them apart); a comparison, never a bill.

/** Dollars per million tokens: a subscription model's list price (`<runtime>:<model>`), for its `equivalent` only. */
interface TokenPrice {
  cached: number;
  input: number;
  output: number;
}
/** Dollars per hour of audio: Scribe, and its keyterms add-on. */
interface HourPrice {
  usdPerHour: number;
}
type Row<P> = P & { from: string; item: string; read: string; source: string };

const CLAUDE = "https://platform.claude.com/docs/en/about-claude/pricing";
// Claude's from the model table of 3 Nov 2026; GPT-6.1 Sol's from its launch, 30 Sep 2026.
const OPENAI = "https://openai.com/api/pricing";
const SCRIBE = "https://elevenlabs.io/pricing/api";
const SONNET = { cached: 0.1, input: 2, output: 10 };
const OPUS = { cached: 0.2, input: 4, output: 20 };
const SOL = { cached: 0.1, input: 2, output: 10 };

/** List prices of the models his subscriptions run (Life's calls, his agents), by `<runtime>:<model>`; `default` is the runtime's own. */
export const TOKEN_PRICES: Row<TokenPrice>[] = [
  // Claude Code's aliases on 21 Nov 2026: opus is Opus 5.5, sonnet Sonnet 5.5, haiku Haiku 5.5 (its cache read at a tenth).
  {
    from: "2026-11-03",
    item: "claude:opus",
    read: "2026-11-21",
    source: CLAUDE,
    ...OPUS,
  },
  {
    from: "2026-11-03",
    item: "claude:default",
    read: "2026-11-21",
    source: CLAUDE,
    ...OPUS,
  },
  {
    from: "2026-11-03",
    item: "claude:sonnet",
    read: "2026-11-21",
    source: CLAUDE,
    ...SONNET,
  },
  // Voice's model on the Mac names the model whole.
  {
    from: "2026-11-03",
    item: "claude:claude-sonnet-5-5",
    read: "2026-11-21",
    source: CLAUDE,
    ...SONNET,
  },
  {
    cached: 0.01,
    from: "2026-11-03",
    input: 0.1,
    item: "claude:haiku",
    output: 0.5,
    read: "2026-11-21",
    source: CLAUDE,
  },
  {
    from: "2026-09-30",
    item: "codex:gpt-6.1-sol",
    read: "2026-11-21",
    source: OPENAI,
    ...SOL,
  },
  {
    from: "2026-09-30",
    item: "codex:default",
    read: "2026-11-21",
    source: OPENAI,
    ...SOL,
  },
];

/** Voice's metered transcription (apps/lifelog's docs/research/elevenlabs.md; keyterms at the higher of two figures). */
export const HOUR_PRICES: Row<HourPrice>[] = [
  // Scribe v2 at $0.22 read on 7 Oct 2026; v3 (and v2) at $0.20 on 11 Nov 2026.
  {
    from: "2026-10-07",
    item: "scribe",
    read: "2026-10-07",
    source: SCRIBE,
    usdPerHour: 0.22,
  },
  {
    from: "2026-11-11",
    item: "scribe",
    read: "2026-11-11",
    source: SCRIBE,
    usdPerHour: 0.2,
  },
  {
    from: "2026-10-07",
    item: "scribe-keyterms",
    read: "2026-11-11",
    source: SCRIBE,
    usdPerHour: 0.05,
  },
];
/** Dollars per request: a paid web search (`web-search/`), by provider. */
interface RequestPrice {
  usdPerRequest: number;
}

/** A web search provider's price per request (a credit, for Serper), by `WebSearchProviderName`; SerpAPI bills by plan. */
const REQUEST_PRICES: Row<RequestPrice>[] = [
  {
    from: "2026-11-22",
    item: "brave",
    read: "2026-11-22",
    source: "https://brave.com/search/api/",
    usdPerRequest: 0.005,
  },
  // Serper's Starter credits, $50 for 50,000; its 2,500 free ones are priced too: a list price, never a bill.
  {
    from: "2026-11-22",
    item: "serper",
    read: "2026-11-22",
    source: "https://serper.dev/",
    usdPerRequest: 0.001,
  },
  {
    from: "2026-11-22",
    item: "perplexity-search",
    read: "2026-11-22",
    source: "https://docs.perplexity.ai/getting-started/pricing",
    usdPerRequest: 0.005,
  },
];
/** `item`'s row in force on `day` (YYYY-MM-DD): the latest whose `from` is on or before it; none before every row. */
export const priceOn = <P>(rows: Row<P>[], item: string, day: string) =>
  rows
    .filter((r) => r.item === item && r.from <= day)
    .toSorted((a, b) => b.from.localeCompare(a.from))[0];

/** `item`'s price per request today (a UTC day, as every row's `from`); undefined when no row prices it. */
export const requestUsdNow = (item: string) =>
  priceOn(REQUEST_PRICES, item, iso(clock().getTime()).slice(0, 10))
    ?.usdPerRequest;

/** What `tokens` cost at `item`'s list price on `day`; undefined when no row prices it. Input counts its cached part. */
export function listUsdOf(
  item: string,
  day: string,
  t: { cached: number; input: number; output: number }
) {
  const p = priceOn(TOKEN_PRICES, item, day);
  return (
    p &&
    ((t.input - t.cached) * p.input +
      t.cached * p.cached +
      t.output * p.output) /
      1e6
  );
}
