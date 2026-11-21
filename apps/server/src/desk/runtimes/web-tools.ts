import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { htmlTextOf } from "../../core/html-text";

// `web_fetch` and `web_search` for an agent of his own Life on pi (Claude Code has its own), given by Life's pi
// extension (`pi-extension.ts`). The web is free to his own agents (SECURITY.md, "Agents"); search goes through SerpAPI
// with his own key, never OpenRouter's web plugin, which its zero-retention routing does not cover.

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
    signal: AbortSignal.any([
      ...(signal ? [signal] : []),
      AbortSignal.timeout(FETCH_WITHIN_MS),
    ]),
  });
  const type = r.headers.get("content-type") ?? "";
  if (!TEXTUAL.test(type)) {
    await r.body?.cancel();
    return `${r.status} ${url}\n\nNot text: ${type || "no type"}, ${r.headers.get("content-length") ?? "unknown"} bytes`;
  }
  const body = await readCapped(r.body);
  return `${r.status} ${url}\n\n${type.includes("html") ? htmlTextOf(body) : body}`;
}

/** Registers `web_fetch`, and `web_search` when his SerpAPI key is given. */
export function registerWebTools(
  pi: ExtensionAPI,
  serpKey: string | undefined
) {
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
  if (!serpKey) {
    return;
  }
  pi.registerTool({
    description:
      "Search the web (Google, through SerpAPI): each result's title, address and snippet.",
    async execute(_id, params: { query: string }, signal) {
      const u = new URL("https://serpapi.com/search.json");
      u.search = new URLSearchParams({
        api_key: serpKey,
        engine: "google",
        q: params.query,
      }).toString();
      const r = (await (await fetch(u, { signal })).json()) as {
        error?: string;
        organic_results?: { link: string; snippet?: string; title: string }[];
      };
      return answer(
        r.error ??
          (r.organic_results ?? [])
            .map((o) => `${o.title}\n${o.link}\n${o.snippet ?? ""}`)
            .join("\n\n")
      );
    },
    label: "Web search",
    name: "web_search",
    parameters: {
      properties: {
        query: { description: "What to search for", type: "string" },
      },
      required: ["query"],
      type: "object",
    } as never,
  });
}
