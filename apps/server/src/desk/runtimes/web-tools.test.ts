import { afterEach, expect, spyOn, test } from "bun:test";
import { webSearch } from "./web-tools";

// `web_search`'s chain over made-up answers of the providers' own hosts: order, a provider without his key skipped,
// a refusal and an empty answer falling through (the empty one still paid), every failure named.

const KEYS = ["BRAVE_SEARCH_API_KEY", "PERPLEXITY_API_KEY"];
const kept = KEYS.map((k) => process.env[k]);
afterEach(() => {
  KEYS.forEach((k, i) => {
    process.env[k] = kept[i];
  });
});

/** Answers each provider's host with `answers[host]`, recording the hosts asked. */
function providers(answers: Record<string, Response>) {
  const hosts: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(((url: string) => {
    const { host } = new URL(url);
    hosts.push(host);
    return Promise.resolve(answers[host] ?? new Response("", { status: 404 }));
  }) as never);
  return { hosts, restore: () => spy.mockRestore() };
}

const BRAVE = "api.search.brave.com";
const PERPLEXITY = "api.perplexity.ai";

test("the first provider that answers is the answer; one without his key is skipped", async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  process.env.PERPLEXITY_API_KEY = "made-up";
  const p = providers({
    [PERPLEXITY]: Response.json({
      results: [{ snippet: "A runtime", title: "Bun", url: "https://bun.sh" }],
    }),
  });
  const { text, usage } = await webSearch("bun", [
    "brave",
    "perplexity-search",
  ]);
  p.restore();
  expect(p.hosts).toEqual([PERPLEXITY]);
  expect(text).toBe("perplexity-search\n\n1. Bun\nhttps://bun.sh\nA runtime");
  expect(usage).toEqual([
    {
      cacheRead: 0,
      cacheWrite: 0,
      cost: { total: 0.005, totalFromProvider: true },
      input: 0,
      output: 0,
      totalTokens: 0,
    },
  ]);
});

test("a refusal falls through unpaid, an empty answer falls through paid, and all failing names each", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "made-up";
  process.env.PERPLEXITY_API_KEY = "made-up";
  const p = providers({
    [BRAVE]: Response.json({ web: { results: [] } }),
    [PERPLEXITY]: new Response("", { status: 503 }),
  });
  const { text, usage } = await webSearch("bun", [
    "brave",
    "perplexity-search",
  ]);
  p.restore();
  expect(p.hosts).toEqual([BRAVE, PERPLEXITY]);
  expect(text).toBe(
    "No search answered. brave: no results; perplexity-search: 503"
  );
  expect(usage.map((u) => u.cost?.total)).toEqual([0.005]);
});
