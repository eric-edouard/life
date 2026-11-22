import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { htmlTextOf } from "../../core/html-text";
import type { WebSearchProviderName } from "../../core/names";
import { webSearch } from "../../web-search/backend";
import type { WebResult } from "../../web-search/contract";
import type { CallUsage } from "./contract";

// `web_fetch` and `web_search` for an agent of his own Life on pi (Claude Code has its own), given by Life's pi
// extension (`pi-extension.ts`). The web is free to his own agents (SECURITY.md, "Agents"). Search is Life's web search
// (`web-search/`) over the providers his `desk.webSearch` names; never OpenRouter's web plugin, which its
// zero-retention routing does not cover. Each paid search comes back as a call's usage of no tokens, added to the
// turn's billed dollars (`pi-runtime.ts`).

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

/** The tool call's signal, ended also past `FETCH_WITHIN_MS`. */
const withinOf = (signal: AbortSignal | undefined) =>
  AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(FETCH_WITHIN_MS),
  ]);

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

/** The most of a result's snippet the agent reads. */
const SNIPPET_CHARS = 500;

/** A paid search as a call's usage of no tokens: `totalFromProvider` reads "its price is known"; one unknown nulls the turn's billed dollars (`addSpent`), never guessed. */
const searchUsageOf = (usd: number | undefined): CallUsage => ({
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: usd ?? 0, totalFromProvider: usd !== undefined },
  input: 0,
  output: 0,
  totalTokens: 0,
});

const resultLine = (r: WebResult, i: number) =>
  `${i + 1}. ${r.title}\n${r.url}\n${r.snippet.slice(0, SNIPPET_CHARS)}`;

/** `web_search`'s answer: the results and who gave them, or why none did; each paid search as a usage. */
export async function searchAnswerOf(
  query: string,
  order: WebSearchProviderName[],
  signal?: AbortSignal
) {
  const { answered, spends, whys } = await webSearch(query, order, signal);
  return {
    text: answered
      ? `${answered.provider}\n\n${answered.results.map(resultLine).join("\n\n")}`
      : `No search answered. ${whys.join("; ")}`,
    usage: spends.map(searchUsageOf),
  };
}

/** Registers `web_search` over `order`. */
export function registerWebSearch(
  pi: ExtensionAPI,
  order: WebSearchProviderName[]
) {
  pi.registerTool({
    description:
      "Search the web; returns the top results, each with its title, address and snippet. Read a result with web_fetch.",
    async execute(_id, params: { query: string }, signal) {
      if (!params.query.trim()) {
        throw new Error("an empty query");
      }
      const { text, usage } = await searchAnswerOf(params.query, order, signal);
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
