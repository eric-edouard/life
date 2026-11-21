import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// What an agent of his own Life has in Claude Code and pi lacks (`docs/plans/pi-runtime.md`, PR 4), given by Life's pi
// extension (`pi-extension.ts`): his own Claude `PreToolUse` command hooks on each shell call, run as Claude runs them,
// and two tools, `web_fetch` and `web_search` (through SerpAPI with his key; never OpenRouter's web plugin, which its
// zero-retention routing does not cover). A second Life's agent gets none of them.

/** His Claude hooks as `~/.claude/settings.json` holds them under `hooks.PreToolUse`. */
export interface ClaudeHookGroup {
  hooks: { command: string; timeout?: number; type: string }[];
  matcher?: string;
}

/** The longest page or result `web_fetch` gives back, in characters. */
const FETCHED_CHARS = 100_000;

/** Why his hooks refuse `call` (Claude's hook JSON on stdin; exit 2 or a deny refuses), or none. */
export async function hookRefusalOf(
  groups: ClaudeHookGroup[],
  call: { cwd: string; tool_input: unknown; tool_name: string }
) {
  const input = JSON.stringify({ hook_event_name: "PreToolUse", ...call });
  for (const g of groups) {
    if (!new RegExp(`^(?:${g.matcher || ".*"})$`).test(call.tool_name)) {
      continue;
    }
    for (const h of g.hooks.filter((x) => x.type === "command")) {
      // biome-ignore lint/performance/noAwaitInLoops: Claude runs a tool's hooks before it, each its verdict
      const why = await commandRefusalOf(h.command, input, h.timeout ?? 60);
      if (why) {
        return why;
      }
    }
  }
}

async function commandRefusalOf(command: string, input: string, s: number) {
  const p = Bun.spawn(["sh", "-c", command], {
    stderr: "pipe",
    stdin: new Blob([input]),
    stdout: "pipe",
    timeout: s * 1000,
  });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code === 2) {
    return err.trim() || "refused by his hook";
  }
  try {
    const o = JSON.parse(out) as {
      decision?: string;
      hookSpecificOutput?: {
        permissionDecision?: string;
        permissionDecisionReason?: string;
      };
      reason?: string;
    };
    const deny = o.hookSpecificOutput?.permissionDecision === "deny";
    if (deny || o.decision === "block") {
      return (
        o.hookSpecificOutput?.permissionDecisionReason ??
        o.reason ??
        "refused by his hook"
      );
    }
  } catch {
    // no JSON: the exit code was the hook's answer
  }
}

/** A page's text: scripts and styles dropped, tags removed, blank runs folded. ponytail: no Markdown structure kept. */
export const pageTextOf = (html: string) =>
  html
    .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();

const text = (t: string) => ({
  content: [{ text: t.slice(0, FETCHED_CHARS), type: "text" as const }],
  details: {},
});

/** Registers `web_fetch` and `web_search` (`serpKey`: his SerpAPI key; none, no search). */
export function registerWebTools(
  pi: ExtensionAPI,
  serpKey: string | undefined
) {
  pi.registerTool({
    description:
      "Fetch a web page (http or https) and return its text, or a JSON or text body as it is.",
    async execute(_id, params: { url: string }, signal) {
      const r = await fetch(params.url, { signal });
      const body = await r.text();
      const isHtml = r.headers.get("content-type")?.includes("html");
      return text(
        `${r.status} ${params.url}\n\n${isHtml ? pageTextOf(body) : body}`
      );
    },
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
      return text(
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
