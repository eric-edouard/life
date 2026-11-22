import { htmlTextOf } from "../core/html-text";
import { requestUsdNow } from "../core/prices";
import { askJson, type WebSearchProvider } from "./contract";

// The Brave Search API: its own index. Its snippets carry markup (`<strong>`), read as text.

export const brave: WebSearchProvider = {
  keyEnv: "BRAVE_SEARCH_API_KEY",
  async search(q, { count, key, signal }) {
    const b = await askJson<{
      web?: {
        results?: { description?: string; title: string; url: string }[];
      };
    }>(
      `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ count: String(count), q })}`,
      {
        headers: { Accept: "application/json", "X-Subscription-Token": key },
        signal,
      }
    );
    return {
      results: (b.web?.results ?? []).map((r) => ({
        snippet: htmlTextOf(r.description ?? ""),
        title: r.title,
        url: r.url,
      })),
      usd: requestUsdNow("brave"),
    };
  },
};
