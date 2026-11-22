import { askJson, type WebSearchProvider } from "./contract";

// SerpAPI's Google engine, only when his `desk.webSearch` names it. It bills by his plan, not by request: its price is
// unknown (`usd` undefined), so a turn that used it reports no billed dollars, never a guess.

export const serpapi: WebSearchProvider = {
  keyEnv: "SERPAPI_API_KEY",
  async search(q, { count, key, signal }) {
    const b = await askJson<{
      organic_results?: { link: string; snippet?: string; title: string }[];
    }>(
      `https://serpapi.com/search.json?${new URLSearchParams({ api_key: key, engine: "google", num: String(count), q })}`,
      { signal }
    );
    return {
      results: (b.organic_results ?? []).map((r) => ({
        snippet: r.snippet ?? "",
        title: r.title,
        url: r.link,
      })),
      usd: undefined,
    };
  },
};
