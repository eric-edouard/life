import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ContextEvent,
  ExtensionAPI,
  ProviderConfig,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { callDoor } from "../../../../claude-plugin/hooks/door";
import { clock } from "../../core/clock";
import type { WebSearchProviderName } from "../../core/names";
import { searchableOf } from "../../web-search/backend";
import { SEND_FACTS_ENV, type SendFacts, sendRefusalOf } from "../send-guard";
import { type ClaudeHookGroup, runClaudeHooks } from "./claude-hooks";
import { DOOR_KEY_ENV } from "./contract";
import { DOOR_TOOL, pruneResults, resultOf } from "./pi-results";
import { registerSubagent } from "./pi-subagent";
import { registerWebFetch, registerWebSearch } from "./web-tools";

// The extension every pi session of the desk loads (`pi -e`, `pi-runtime.ts`): inside the pi process, before every tool
// call, whatever its name, Life's send guard (`send-guard.ts`); after each, its result as the model reads it
// (`pi-results.ts`: data wrapped, a long one kept in a file); on every request, what holds on every turn (`inForce`);
// the agent's door as MCP server `desk`; and Life's model provider, `PI_PROVIDER`, whose models carry Life's routing
// (`compat.openRouterRouting`), which pi puts on every request of the provider, compaction's included (the owner's
// decision 3 of 22 Nov 2026, `docs/plans/pi-runtime.md`). For an agent of his own Life also his Claude hooks after the
// guard, on shell calls (`claude-hooks.ts`), and `web_fetch` (`web-tools.ts`). Everything comes from the spawn's environment. pi blocks a
// call whose `tool_call` handler throws, so a guard that cannot decide refuses. pi only logs an extension that fails to
// load: the runtime checks `PI_EXTENSION_COMMAND` before it prompts. After each tool call, the work's spending stop
// (`stopAtSpendingStop`): past it, only the door's tools run, so the turn ends with its notes and its card.

/** The command this extension registers: the runtime starts no turn on a pi that does not list it. */
export const PI_EXTENSION_COMMAND = "life-desk";

/** The provider this extension registers: the runtime runs pi with `--provider` this. */
export const PI_PROVIDER = "life";

/** What the runtime puts in pi's environment for this extension. */
export const PI_EXTENSION_ENV = {
  doorKey: DOOR_KEY_ENV,
  doorUrl: "LIFE_DESK_URL",
  facts: SEND_FACTS_ENV,
  /** His Claude `PreToolUse` hooks (JSON), for his own Life (`claude-hooks.ts`). */
  hooks: "LIFE_PI_HOOKS",
  /** The file holding what is in force on every request (`Agent.inForce`), rewritten by the runtime before each prompt. */
  inForce: "LIFE_PI_IN_FORCE",
  key: "LIFE_PI_KEY",
  /** `1` for an agent of his own Life: his hooks and the web tools; a second Life's agent gets neither. */
  own: "LIFE_PI_OWN",
  provider: "LIFE_PI_PROVIDER",
  /** The connector's reads as a stdio MCP entry (JSON), for his own Life. */
  reads: "LIFE_CONNECTOR_READS",
  /** The agent's rules (`Agent.rules`): a section of every run's system prompt. */
  rules: "LIFE_PI_RULES",
  /** The providers `web_search` asks, in order (JSON, `desk.webSearch`), for his own Life. */
  search: "LIFE_PI_SEARCH",
} as const;

/** The provider as the runtime gives it (`LIFE_PI_PROVIDER`): everything but its key. */
export type PiProvider = Omit<ProviderConfig, "apiKey">;

/** The custom entry that records the tool schemas' size once per process (`desk.tool_schemas`, `pi-runtime.ts`). */
export const TOOL_SCHEMAS = "life-tool-schemas";

/** pi's shell tools, each read by the guard as Claude's `Bash` (both take `command`). */
const SHELLS = ["bash", "powershell"];

/** A pi tool call as the guard reads Claude's: a shell is `Bash`; MCP tools share the `mcp__<server>__<tool>` shape. */
const guardedCallOf = (toolName: string, input: unknown) => ({
  tool_input: input,
  tool_name: SHELLS.includes(toolName) ? "Bash" : toolName,
});

/** What the extension runs on, read from the spawn's environment once (`lifeDeskOf`'s default) or handed to a subagent. */
export interface LifeDeskConfig {
  apiKey: string;
  /** The agent's door; none in a subagent: its cards and waits stay the agent's own. */
  door?: { key: string; url: string };
  facts: SendFacts;
  hooks: ClaudeHookGroup[];
  /** The file of what is in force on every request (`PI_EXTENSION_ENV.inForce`); none in a subagent. */
  inForce?: string;
  /** An agent of his own Life: his hooks, `web_fetch`, the connector's reads and subagents. */
  isOwn: boolean;
  provider: PiProvider;
  /** The connector's reads (`life connector-reads`) as a stdio MCP server; none in a subagent. */
  reads?: { args: string[]; command: string; env: Record<string, string> };
  /** Where long tool results are kept (`pi-results.ts`). */
  results: string;
  /** The agent's rules, pinned as a system prompt section; none in a subagent. */
  rules?: string;
  /** The providers `web_search` asks, in order; none, no `web_search`. */
  search: WebSearchProviderName[];
}

/** pi's MCP server name for the connector's reads (`mcp__life_connector__<tool>`); `life` is the door's in his own sessions. */
export const READS_SERVER = "life_connector";

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Life's pi extension needs ${name}`);
  }
  return value;
};

/** A value of the environment, taken out of it once read, so no command the agent runs inherits it. */
const taken = (name: string) => {
  const value = process.env[name];
  delete process.env[name];
  return value;
};

/** The extension's config from the spawn's environment (`PI_EXTENSION_ENV`), the key and the reads' entry taken out. */
function configOfEnv(): LifeDeskConfig {
  const env = PI_EXTENSION_ENV;
  const apiKey = required(env.key);
  taken(env.key);
  const isOwn = process.env[env.own] === "1";
  const reads = taken(env.reads);
  const rules = process.env[env.rules];
  const inForce = process.env[env.inForce];
  return {
    apiKey,
    door: { key: required(env.doorKey), url: required(env.doorUrl) },
    facts: JSON.parse(required(env.facts)),
    hooks: isOwn ? JSON.parse(process.env[env.hooks] ?? "[]") : [],
    ...(inForce ? { inForce } : {}),
    isOwn,
    provider: JSON.parse(required(env.provider)),
    ...(isOwn && reads ? { reads: JSON.parse(reads) } : {}),
    results: join(process.env.PI_CODING_AGENT_DIR ?? ".", "results"),
    ...(rules ? { rules } : {}),
    search: isOwn ? JSON.parse(process.env[env.search] ?? "[]") : [],
  };
}

/** The system prompt section holding the agent's rules (`<life-desk>`). */
const RULES_SECTION = "life-desk";

/** An old tool answer kept whole up to this many characters: a note of it would not be much shorter. */
const OLD_ANSWER_KEPT = 1000;

/**
 * What the model is sent of the session: each tool answer of an earlier wake (before the last prompt), but the door's,
 * as a one-line note of what was read; the session file keeps every answer (pi's `context` hook changes only the
 * request). None when nothing changes, so the request keeps its cached prefix.
 */
export function contextOf(messages: ContextEvent["messages"]) {
  const last = messages.findLastIndex((m) => m.role === "user");
  let isChanged = false;
  const sent = messages.map((m, i) => {
    if (
      i > last ||
      m.role !== "toolResult" ||
      m.toolName.startsWith(DOOR_TOOL)
    ) {
      return m;
    }
    const chars = m.content.reduce(
      (n, c) => n + (c.type === "text" ? c.text.length : OLD_ANSWER_KEPT),
      0
    );
    if (chars <= OLD_ANSWER_KEPT) {
      return m;
    }
    isChanged = true;
    return {
      ...m,
      content: [
        {
          text: `(${m.toolName}'s answer of an earlier turn, ${chars} characters, is out of your context: call it again if you need it.)`,
          type: "text" as const,
        },
      ],
    };
  });
  return isChanged ? { messages: sent } : undefined;
}

/** The tag around what is in force on every request. */
const IN_FORCE_TAG = "in-force";

/** The file's text, none when empty or not there (no ask has set it yet). */
const readInForce = (file: string) => {
  try {
    return readFileSync(file, "utf8").trim() || undefined;
  } catch {
    // not written yet: nothing in force
  }
};

/**
 * `messages` with what is in force after them, as one user message the request carries and the session never keeps:
 * on every request, so it is never lost at compaction or sunk under a long session (the v4 plan, bundle C).
 */
export const withInForceOf = (
  messages: ContextEvent["messages"],
  inForce: string
): ContextEvent["messages"] => [
  ...messages,
  {
    content: `<${IN_FORCE_TAG}>\n${inForce}\n</${IN_FORCE_TAG}>`,
    role: "user",
    timestamp: 0,
  },
];

/** The line between Life's record and pi's summary of the talk, in a compaction's summary. */
const TALK_LINE = "What the session did, summarized:";

/** Reads `url` as text, the plugin's fetch (`door.ts`). */
const fetchText = async (
  url: string,
  init?: { body?: string; headers?: Record<string, string>; method?: string }
) => {
  const r = await fetch(url, init);
  return { status: r.status, text: await r.text() };
};

/**
 * Life writes each compaction's summary (the owner's yes of 22 Nov 2026, item 2): its record of the turn's assignment
 * word for word, as the door's `read_packet` gives it (the matter as read now, its notes, its wait, its open card), then
 * pi's own summary of the talk, which never re-reads an earlier record. No record (the door refused or is down), or a
 * summary call that failed: pi's own compaction.
 */
function keepRecordOnCompaction(
  pi: ExtensionAPI,
  door: { key: string; url: string },
  apiKey: string
) {
  pi.on("session_before_compact", async (event, ctx) => {
    const record = await callDoor(fetchText, door, "read_packet", {}).catch(
      () => undefined
    );
    if (!(record && !record.isError && ctx.model)) {
      return;
    }
    const { compact } = await import("@earendil-works/pi-coding-agent");
    const { preparation } = event;
    const result = await compact(
      {
        ...preparation,
        previousSummary: preparation.previousSummary?.split(TALK_LINE).at(-1),
      },
      ctx.model,
      apiKey,
      undefined,
      event.customInstructions,
      event.signal,
      pi.getThinkingLevel()
    ).catch(() => undefined);
    // A summary call that failed: pi compacts on its own, or reports why.
    if (!result) {
      return;
    }
    return {
      compaction: {
        ...result,
        summary: `${record.text}\n\n${TALK_LINE}\n${result.summary}`,
      },
    };
  });
}

/** What the model calls of the current turn (since the last prompt) were billed, as pi read each response's cost. */
const turnBilledOf = (entries: readonly SessionEntry[]) =>
  entries
    .slice(
      entries.findLastIndex(
        (e) => e.type === "message" && e.message.role === "user"
      ) + 1
    )
    .reduce(
      (n, e) =>
        n +
        (e.type === "message" && e.message.role === "assistant"
          ? (e.message.usage?.cost?.total ?? 0)
          : 0),
      0
    );

/**
 * The spending stop inside a turn (the v4.1 plan): after each tool call, what the turn was billed goes to the door
 * (`POST /spending/<agent>`); once the desk answers a stop, every later call but the door's (its notes, its card, its
 * wait) is refused with the desk's line, so the turn ends there. A door that cannot answer stops nothing.
 * ponytail: the turn's spending tools (subagents, searches) are not counted here; the desk counts them at the turn's end.
 */
function stopAtSpendingStop(
  pi: ExtensionAPI,
  door: { key: string; url: string }
) {
  const url = door.url.replace("/mcp/", "/spending/");
  let stop: string | undefined;
  pi.on("agent_start", () => {
    stop = undefined;
  });
  pi.on("tool_result", async (_event, ctx) => {
    if (stop) {
      return;
    }
    const usd = turnBilledOf(ctx.sessionManager.getBranch());
    const r = await fetch(url, {
      body: JSON.stringify({ usd }),
      headers: {
        authorization: `Bearer ${door.key}`,
        "content-type": "application/json",
      },
      method: "POST",
    }).catch(() => undefined);
    const answer =
      r?.status === 200
        ? ((await r.json()) as { stop: string | null })
        : undefined;
    stop = answer?.stop ?? undefined;
  });
  pi.on("tool_call", (event) =>
    stop && !event.toolName.startsWith(DOOR_TOOL)
      ? { block: true, reason: stop }
      : undefined
  );
}

/** The extension on `config`: the default export's, and each subagent's (`pi-subagent.ts`) with no door or reads. */
export const lifeDeskOf = (config: LifeDeskConfig) => (pi: ExtensionAPI) => {
  pi.registerProvider(PI_PROVIDER, {
    ...config.provider,
    apiKey: config.apiKey,
  });
  // A repo's own `.pi` (extensions, MCP servers, settings) never loads beside this one: it could rewrite a request.
  pi.on("project_trust", () => ({ trusted: "no" }));
  if (config.door) {
    pi.registerMcpServer("desk", {
      exposure: "direct",
      headers: { Authorization: `Bearer ${config.door.key}` },
      url: config.door.url,
    });
  }
  if (config.reads) {
    pi.registerMcpServer(READS_SERVER, { exposure: "direct", ...config.reads });
  }
  pi.registerCommand(PI_EXTENSION_COMMAND, {
    description: "Life's desk: the send guard, the door and Life's provider",
    handler: async () => undefined,
  });
  if (config.isOwn) {
    registerWebFetch(pi);
  }
  // Only while one of his providers has its key: a search that cannot answer would only cost the agent calls.
  if (config.isOwn && searchableOf(config.search).length > 0) {
    registerWebSearch(pi, config.search);
  }
  if (config.isOwn && config.door) {
    registerSubagent(
      pi,
      lifeDeskOf({
        ...config,
        door: undefined,
        inForce: undefined,
        reads: undefined,
        rules: undefined,
      })
    );
  }
  const { rules } = config;
  if (rules) {
    // A section, not a message: no compaction summarizes it, and pi diffs it, so an unchanged one keeps the cached prefix.
    pi.on("before_agent_start", (event) => {
      event.systemPromptOptions.sections[RULES_SECTION] = rules;
    });
  }
  const { door, inForce } = config;
  pi.on("context", (event) => {
    const sent = door ? contextOf(event.messages) : undefined;
    const block = inForce && readInForce(inForce);
    return block
      ? { messages: withInForceOf(sent?.messages ?? event.messages, block) }
      : sent;
  });
  if (door) {
    keepRecordOnCompaction(pi, door, config.apiKey);
    stopAtSpendingStop(pi, door);
  }
  pruneResults(config.results, clock().getTime());
  pi.on("tool_result", (event) => resultOf(event, config.results));
  let isSchemaSizeKept = false;
  pi.on("before_agent_start", (event) => {
    if (isSchemaSizeKept) {
      return;
    }
    isSchemaSizeKept = true;
    const selected = new Set(event.systemPromptOptions.selectedTools);
    const tools = pi.getAllTools().filter((t) => selected.has(t.name));
    pi.appendEntry(TOOL_SCHEMAS, {
      chars: tools.reduce(
        (n, t) =>
          n + t.description.length + JSON.stringify(t.parameters).length,
        0
      ),
      tools: tools.length,
    });
  });
  // Every call, whatever its name: a tool that comes later (a search's, a server's) is guarded as it comes.
  pi.on("tool_call", async (event, ctx) => {
    const call = guardedCallOf(event.toolName, event.input);
    const why =
      sendRefusalOf(call, config.facts) ??
      (call.tool_name === "Bash"
        ? await runClaudeHooks(config.hooks, { ...call, cwd: ctx.cwd })
        : undefined);
    return why ? { block: true, reason: why } : undefined;
  });
};

export default function lifeDesk(pi: ExtensionAPI) {
  lifeDeskOf(configOfEnv())(pi);
}
