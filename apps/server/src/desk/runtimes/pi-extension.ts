import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import type { WebSearchProviderName } from "../../core/names";
import {
  SEND_FACTS_ENV,
  SEND_GUARD_HOOK,
  type SendFacts,
  sendRefusalOf,
} from "../send-guard";
import { type ClaudeHookGroup, runClaudeHooks } from "./claude-hooks";
import { DOOR_KEY_ENV } from "./contract";
import { registerSubagent } from "./pi-subagent";
import { registerWebFetch, registerWebSearch } from "./web-tools";

// The extension every pi session of the desk loads (`pi -e`, `pi-runtime.ts`): inside the pi process, before each tool
// call, Life's send guard (`send-guard.ts`), on the calls Claude's and Codex's hook reads (`SEND_GUARD_HOOK.matcher`);
// the agent's door as MCP server `desk`; and Life's model provider, `PI_PROVIDER`, whose models carry Life's routing
// (`compat.openRouterRouting`), which pi puts on every request of the provider, compaction's included (the owner's
// decision 3 of 22 Nov 2026, `docs/plans/pi-runtime.md`). For an agent of his own Life also his Claude hooks after the
// guard, on shell calls (`claude-hooks.ts`), and `web_fetch` (`web-tools.ts`). Everything comes from the spawn's environment. pi blocks a
// call whose `tool_call` handler throws, so a guard that cannot decide refuses. pi only logs an extension that fails to
// load: the runtime checks `PI_EXTENSION_COMMAND` before it prompts.

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
  key: "LIFE_PI_KEY",
  /** `1` for an agent of his own Life: his hooks and the web tools; a second Life's agent gets neither. */
  own: "LIFE_PI_OWN",
  provider: "LIFE_PI_PROVIDER",
  /** The connector's reads as a stdio MCP entry (JSON), for his own Life. */
  reads: "LIFE_CONNECTOR_READS",
  /** The providers `web_search` asks, in order (JSON, `desk.webSearch`), for his own Life. */
  search: "LIFE_PI_SEARCH",
} as const;

/** The provider as the runtime gives it (`LIFE_PI_PROVIDER`): everything but its key. */
export type PiProvider = Omit<ProviderConfig, "apiKey">;

/** The calls the guard reads, as the hook's matcher names them. */
const GUARDED = new RegExp(`^(${SEND_GUARD_HOOK.matcher})$`);

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
  /** An agent of his own Life: his hooks, `web_fetch`, the connector's reads and subagents. */
  isOwn: boolean;
  provider: PiProvider;
  /** The connector's reads (`life connector-reads`) as a stdio MCP server; none in a subagent. */
  reads?: { args: string[]; command: string; env: Record<string, string> };
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
  return {
    apiKey,
    door: { key: required(env.doorKey), url: required(env.doorUrl) },
    facts: JSON.parse(required(env.facts)),
    hooks: isOwn ? JSON.parse(process.env[env.hooks] ?? "[]") : [],
    isOwn,
    provider: JSON.parse(required(env.provider)),
    ...(isOwn && reads ? { reads: JSON.parse(reads) } : {}),
    search: isOwn ? JSON.parse(process.env[env.search] ?? "[]") : [],
  };
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
  if (config.isOwn && config.search.length > 0) {
    registerWebSearch(pi, config.search);
  }
  if (config.isOwn && config.door) {
    registerSubagent(
      pi,
      lifeDeskOf({ ...config, door: undefined, reads: undefined })
    );
  }
  pi.on("tool_call", async (event, ctx) => {
    const call = guardedCallOf(event.toolName, event.input);
    if (!GUARDED.test(call.tool_name)) {
      return;
    }
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
