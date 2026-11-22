// The web search contract: what a result is to Life (`WebResult`) and what a provider does (`WebSearchProvider`). Each
// provider is one file; `backend.ts` names them (`WEB_SEARCH_PROVIDERS`) and asks them in his order (`webSearch`).

/** One result of a search, as every provider gives it. */
export interface WebResult {
  snippet: string;
  title: string;
  url: string;
}

/** What one paid search answered: its results (none is an answer too) and its price in dollars, undefined when unknown. */
export interface Searched {
  results: WebResult[];
  usd: number | undefined;
}

export interface WebSearchProvider {
  /** The environment variable holding his key: the provider is skipped while it is missing. */
  keyEnv: string;
  /** One search for at most `count` results; it throws on a refusal or a failure, when nothing was paid. */
  search: (
    query: string,
    o: { count: number; key: string; signal: AbortSignal }
  ) => Promise<Searched>;
}

/** A provider's JSON answer to `url`; a refusal throws with its status. */
export async function askJson<T>(url: string, init: RequestInit): Promise<T> {
  const r = await fetch(url, init);
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`${r.status}`);
  }
  return (await r.json()) as T;
}
