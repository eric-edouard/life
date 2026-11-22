import type { WebSearchProviderName } from "../core/names";
import { brave } from "./brave";
import type { Searched, WebResult, WebSearchProvider } from "./contract";
import { perplexitySearch } from "./perplexity-search";
import { serpapi } from "./serpapi";
import { serper } from "./serper";
import { tavily } from "./tavily";

// The web search providers by name, and his chain over them: the one way Life searches the web.

/** Every provider, by the name his `desk.webSearch` gives it: a new one is its file and its line here. */
const WEB_SEARCH_PROVIDERS: Record<WebSearchProviderName, WebSearchProvider> = {
  brave,
  "perplexity-search": perplexitySearch,
  serpapi,
  serper,
  tavily,
};

/** The providers of `order` whose key is in this environment: the ones a search can ask. */
export const searchableOf = (order: WebSearchProviderName[]) =>
  order.filter((n) => process.env[WEB_SEARCH_PROVIDERS[n].keyEnv]);

/** The chain when his `desk.webSearch` names none (the owner's word of 22 Nov 2026). */
export const WEB_SEARCH_CHAIN: WebSearchProviderName[] = [
  "tavily",
  "serper",
  "brave",
  "perplexity-search",
];

/** The most results a search asks for, and how long one provider may take before the next is asked. */
const RESULTS = 10;
const PROVIDER_WITHIN_MS = 10_000;

export interface WebSearched {
  /** The provider that answered with results, and them; none when no provider did. */
  answered?: { provider: WebSearchProviderName; results: WebResult[] };
  /** Each paid search's price, in order, the ones that fell through included; undefined when its price is unknown. */
  spends: Searched["usd"][];
  /** Why each provider asked before the answer gave nothing. */
  whys: string[];
}

/**
 * `query` asked of `order`'s providers in turn: one without his key is skipped; a refusal, a failure, a provider past
 * `PROVIDER_WITHIN_MS` or no results moves on to the next. Every answered search is a spend, results or not.
 */
export async function webSearch(
  query: string,
  order: WebSearchProviderName[],
  signal?: AbortSignal
): Promise<WebSearched> {
  const spends: Searched["usd"][] = [];
  const whys: string[] = [];
  for (const provider of order) {
    const p = WEB_SEARCH_PROVIDERS[provider];
    const key = process.env[p.keyEnv];
    if (!key) {
      whys.push(`${provider}: no ${p.keyEnv}`);
      continue;
    }
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a chain: the next provider is asked only when this one fails
      const s = await p.search(query, {
        count: RESULTS,
        key,
        signal: AbortSignal.any([
          ...(signal ? [signal] : []),
          AbortSignal.timeout(PROVIDER_WITHIN_MS),
        ]),
      });
      spends.push(s.usd);
      if (s.results.length > 0) {
        return {
          answered: { provider, results: s.results.slice(0, RESULTS) },
          spends,
          whys,
        };
      }
      whys.push(`${provider}: no results`);
    } catch (e) {
      if (signal?.aborted) {
        throw e;
      }
      whys.push(`${provider}: ${String(e)}`);
    }
  }
  return { spends, whys };
}
