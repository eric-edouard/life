import { requestUsdNow } from "../core/prices";
import { askJson, type WebSearchProvider } from "./contract";

// Perplexity's Search API (not its answering models): ranked pages with snippets.

export const perplexitySearch: WebSearchProvider = {
  keyEnv: "PERPLEXITY_API_KEY",
  async search(q, { count, key, signal }) {
    const b = await askJson<{
      results?: { snippet?: string; title: string; url: string }[];
    }>("https://api.perplexity.ai/search", {
      body: JSON.stringify({ max_results: count, query: q }),
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal,
    });
    return {
      results: (b.results ?? []).map((r) => ({
        snippet: r.snippet ?? "",
        title: r.title,
        url: r.url,
      })),
      usd: requestUsdNow("perplexity-search"),
    };
  },
};
