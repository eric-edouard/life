import { afterEach, expect, spyOn, test } from "bun:test";
import { searchableOf, webSearch } from "./backend";

// Life's web search over made-up answers of the providers' own hosts: his order, a provider without his key skipped, a
// refusal falling through unpaid and an empty answer falling through paid, Serper's credits priced, every failure named.

const KEYS = ["BRAVE_SEARCH_API_KEY", "PERPLEXITY_API_KEY", "SERPER_API_KEY"];
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
const SERPER = "google.serper.dev";

test("the first provider with results answers; one without his key is skipped; Serper's credits are its price", async () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  process.env.SERPER_API_KEY = "made-up";
  process.env.PERPLEXITY_API_KEY = "made-up";
  const p = providers({
    [PERPLEXITY]: Response.json({
      results: [{ snippet: "A runtime", title: "Bun", url: "https://bun.sh" }],
    }),
    [SERPER]: Response.json({ credits: 2, organic: [] }),
  });
  const searched = await webSearch("bun", [
    "serper",
    "brave",
    "perplexity-search",
  ]);
  p.restore();
  expect(p.hosts).toEqual([SERPER, PERPLEXITY]);
  expect(searched).toEqual({
    answered: {
      provider: "perplexity-search",
      results: [{ snippet: "A runtime", title: "Bun", url: "https://bun.sh" }],
    },
    spends: [0.002, 0.005],
    whys: ["serper: no results", "brave: no BRAVE_SEARCH_API_KEY"],
  });
});

test("a refusal falls through unpaid, Brave's markup is read as text, and all failing names each", async () => {
  process.env.BRAVE_SEARCH_API_KEY = "made-up";
  process.env.PERPLEXITY_API_KEY = "made-up";
  const p = providers({
    [BRAVE]: Response.json({
      web: {
        results: [
          {
            description: "A <strong>fast</strong> runtime",
            title: "Bun",
            url: "https://bun.sh",
          },
        ],
      },
    }),
    [PERPLEXITY]: new Response("", { status: 503 }),
  });
  const failed = await webSearch("bun", ["perplexity-search"]);
  const answered = await webSearch("bun", ["perplexity-search", "brave"]);
  p.restore();
  expect(failed).toEqual({
    spends: [],
    whys: ["perplexity-search: Error: 503"],
  });
  expect(answered.answered?.results[0]?.snippet).toContain("fast");
  expect(answered.answered?.results[0]?.snippet).not.toContain("<");
  expect(answered.spends).toEqual([0.005]);
});

test("a provider is searchable only while its key is in the environment", () => {
  delete process.env.BRAVE_SEARCH_API_KEY;
  process.env.SERPER_API_KEY = "made-up";
  expect(searchableOf(["brave", "serper"])).toEqual(["serper"]);
});
