import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clock } from "../../core/clock";
import { htmlTextOf } from "../../core/html-text";
import type { WebSearchProvider } from "../../core/names";
import { priceOn, REQUEST_PRICES } from "../../core/prices";
import type { CallUsage } from "./pi-subagent";

// `web_fetch` and `web_search` for an agent of his own Life on pi (Claude Code has its own), given by Life's pi
// extension (`pi-extension.ts`). The web is free to his own agents (SECURITY.md, "Agents"). Search asks the providers
// his `desk.webSearch` names, in order (the owner's chain of 22 Nov 2026), each with his key from his environment;
// never OpenRouter's web plugin, which its zero-retention routing does not cover. Each paid request comes back as a
// call's usage of no tokens, its price from `REQUEST_PRICES`, added to the turn's billed dollars (`pi-runtime.ts`).

/** The most `web_fetch` reads of a body, and gives back as text. */
const FETCH_BYTES = 2_000_000;
const FETCH_CHARS = 100_000;
const FETCH_WITHIN_MS = 30_000;

/** Bodies `web_fetch` reads as text: any `text/`, JSON, XML, JavaScript. */
const TEXTUAL = /^text\/|json|xml|javascript/;

const answer = (t: string) => ({
  content: [{ text: t.slice(0, FETCH_CHARS), type: "text" as const }],
  details: {},
});

/** The tool call's signal, ended also past `ms`. */
const withinOf = (signal: AbortSignal | undefined, ms = FETCH_WITHIN_MS) =>
  AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(ms)]);

/** The first `FETCH_BYTES` of a body, as text. */
async function readCapped(body: ReadableStream<Uint8Array> | null) {
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body ?? []) {
    parts.push(chunk);
    size += chunk.length;
    if (size >= FETCH_BYTES) {
      break;
    }
  }
  return new TextDecoder().decode(
    Buffer.concat(parts).subarray(0, FETCH_BYTES)
  );
}

/** `url`'s status and text: a page's text, a textual body as it is, any other body by its type alone. */
export async function webFetch(url: string, signal?: AbortSignal) {
  const r = await fetch(url, {
    signal: withinOf(signal),
  });
  const type = r.headers.get("content-type") ?? "";
  if (!TEXTUAL.test(type)) {
    await r.body?.cancel();
    return `${r.status} ${url}\n\nNot text: ${type || "no type"}, ${r.headers.get("content-length") ?? "unknown"} bytes`;
  }
  const body = await readCapped(r.body);
  return `${r.status} ${url}\n\n${type.includes("html") ? htmlTextOf(body) : body}`;
}

/** Registers `web_fetch`. */
export function registerWebFetch(pi: ExtensionAPI) {
  pi.registerTool({
    description:
      "Fetch a web page (http or https) and return its text, or a JSON or text body as it is.",
    execute: async (_id, params: { url: string }, signal) =>
      answer(await webFetch(params.url, signal)),
    label: "Web fetch",
    name: "web_fetch",
    parameters: {
      properties: {
        url: { description: "The page's address", type: "string" },
      },
      required: ["url"],
      type: "object",
    } as never,
  });
}

/** The tool's name: its result's usage is a spend (`SPENDING_TOOLS`). */
export const WEB_SEARCH = "web_search";

/** The results `web_search` asks each provider for, the most of a snippet, and how long one provider may take. */
const SEARCH_RESULTS = 10;
const SNIPPET_CHARS = 500;
const SEARCH_WITHIN_MS = 10_000;

interface Found {
  snippet?: string;
  title?: string;
  url?: string;
}

/** Each provider: the environment variable holding his key, its request, and its results. */
const SEARCHES: Record<
  WebSearchProvider,
  {
    found: (body: never) => Found[] | undefined;
    key: string;
    request: (query: string, key: string) => [string, RequestInit];
  }
> = {
  brave: {
    found: (b: { web?: { results?: (Found & { description?: string })[] } }) =>
      b.web?.results?.map((r) => ({ ...r, snippet: r.description })),
    key: "BRAVE_SEARCH_API_KEY",
    request: (q, key) => [
      `https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ count: String(SEARCH_RESULTS), q })}`,
      { headers: { Accept: "application/json", "X-Subscription-Token": key } },
    ],
  },
  "perplexity-search": {
    found: (b: { results?: Found[] }) => b.results,
    key: "PERPLEXITY_API_KEY",
    request: (q, key) => [
      "https://api.perplexity.ai/search",
      {
        body: JSON.stringify({ max_results: SEARCH_RESULTS, query: q }),
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      },
    ],
  },
};

/**
 * One paid request as a call's usage: no tokens, its price on today's row. `totalFromProvider` reads "the billed amount
 * is known"; a provider with no row nulls the turn's billed dollars (`addSpent`), never guessed.
 */
function requestUsageOf(provider: WebSearchProvider): CallUsage {
  const p = priceOn(
    REQUEST_PRICES,
    provider,
    clock().toISOString().slice(0, 10)
  );
  return {
    cacheRead: 0,
    cacheWrite: 0,
    cost: { total: p?.usdPerRequest ?? 0, totalFromProvider: Boolean(p) },
    input: 0,
    output: 0,
    totalTokens: 0,
  };
}

const foundLine = (f: Found, i: number) =>
  `${i + 1}. ${f.title ?? ""}\n${f.url ?? ""}\n${(f.snippet ?? "").slice(0, SNIPPET_CHARS)}`;

/**
 * The first results of `order`'s providers: one without his key is skipped; an error, a refusal or no results falls
 * through to the next. Every request a provider answered is a spend (`usage`), the ones fallen through included.
 */
export async function webSearch(
  query: string,
  order: WebSearchProvider[],
  signal?: AbortSignal
) {
  const usage: CallUsage[] = [];
  const whys: string[] = [];
  for (const name of order) {
    const p = SEARCHES[name];
    const key = process.env[p.key];
    if (!key) {
      whys.push(`${name}: no ${p.key}`);
      continue;
    }
    const [url, init] = p.request(query, key);
    try {
      // biome-ignore lint/performance/noAwaitInLoops: a chain: the next provider is asked only when this one fails
      const r = await fetch(url, {
        ...init,
        signal: withinOf(signal, SEARCH_WITHIN_MS),
      });
      if (!r.ok) {
        await r.body?.cancel();
        whys.push(`${name}: ${r.status}`);
        continue;
      }
      usage.push(requestUsageOf(name));
      const found = (p.found((await r.json()) as never) ?? []).slice(
        0,
        SEARCH_RESULTS
      );
      if (found.length > 0) {
        return {
          text: `${name}\n\n${found.map(foundLine).join("\n\n")}`,
          usage,
        };
      }
      whys.push(`${name}: no results`);
    } catch (e) {
      if (signal?.aborted) {
        throw e;
      }
      whys.push(`${name}: ${String(e)}`);
    }
  }
  return { text: `No search answered. ${whys.join("; ")}`, usage };
}

/** Registers `web_search` over `order`. */
export function registerWebSearch(
  pi: ExtensionAPI,
  order: WebSearchProvider[]
) {
  pi.registerTool({
    description:
      "Search the web; returns the top results, each with its title, address and snippet. Read a result with web_fetch.",
    async execute(_id, params: { query: string }, signal) {
      if (!params.query.trim()) {
        throw new Error("an empty query");
      }
      const { text, usage } = await webSearch(params.query, order, signal);
      return { ...answer(text), details: { usage } };
    },
    label: "Web search",
    name: WEB_SEARCH,
    parameters: {
      properties: {
        query: { description: "What to search for", type: "string" },
      },
      required: ["query"],
      type: "object",
    } as never,
  });
}
