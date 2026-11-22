import { requestUsdNow } from "../core/prices";
import { askJson, type WebSearchProvider } from "./contract";

// Tavily (tavily.com): a basic search costs the credits its usage names (one). Quota out answers 432 or 429: a refusal.

export const tavily: WebSearchProvider = {
  keyEnv: "TAVILY_API_KEY",
  async search(q, { count, key, signal }) {
    const b = await askJson<{
      results?: { content?: string; title: string; url: string }[];
      usage?: { credits?: number };
    }>("https://api.tavily.com/search", {
      body: JSON.stringify({
        include_usage: true,
        max_results: count,
        query: q,
      }),
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      method: "POST",
      signal,
    });
    const usd = requestUsdNow("tavily");
    return {
      results: (b.results ?? []).map((r) => ({
        snippet: r.content ?? "",
        title: r.title,
        url: r.url,
      })),
      usd: usd === undefined ? undefined : usd * (b.usage?.credits ?? 1),
    };
  },
};
