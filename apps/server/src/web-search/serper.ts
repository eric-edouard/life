import { requestUsdNow } from "../core/prices";
import { askJson, type WebSearchProvider } from "./contract";

// Serper (serper.dev): Google's results. A search costs the credits its answer names (one for a plain search).

export const serper: WebSearchProvider = {
  keyEnv: "SERPER_API_KEY",
  async search(q, { count, key, signal }) {
    const b = await askJson<{
      credits?: number;
      organic?: { link: string; snippet?: string; title: string }[];
    }>("https://google.serper.dev/search", {
      body: JSON.stringify({ num: count, q }),
      headers: { "Content-Type": "application/json", "X-API-KEY": key },
      method: "POST",
      signal,
    });
    const usd = requestUsdNow("serper");
    return {
      results: (b.organic ?? []).map((r) => ({
        snippet: r.snippet ?? "",
        title: r.title,
        url: r.link,
      })),
      usd: usd === undefined ? undefined : usd * (b.credits ?? 1),
    };
  },
};
