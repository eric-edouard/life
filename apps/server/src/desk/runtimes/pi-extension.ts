import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SEND_FACTS_ENV, SEND_GUARD_HOOK, sendRefusalOf } from "../send-guard";

// The extension every pi session of the desk loads (`pi -e`, `pi-runtime.ts`): inside the pi process, before each tool
// call, Life's send guard (`send-guard.ts`), on the calls Claude's and Codex's hook reads (`SEND_GUARD_HOOK.matcher`);
// the agent's door as MCP server `desk`; and Life's routing written over every provider request, so no request reaches
// a host outside Life's list (the owner's decision 3 of 22 Nov 2026, `docs/plans/pi-runtime.md`). Everything comes from
// the spawn's environment. pi blocks a call whose `tool_call` handler throws, so a guard that cannot decide refuses.
// pi only logs an extension that fails to load: the runtime checks `PI_EXTENSION_COMMAND` before it prompts.

/** The command this extension registers: the runtime starts no turn on a pi that does not list it. */
export const PI_EXTENSION_COMMAND = "life-desk";

/** What the runtime puts in pi's environment for this extension. */
export const PI_EXTENSION_ENV = {
  doorKey: "LIFE_DESK_KEY",
  doorUrl: "LIFE_DESK_URL",
  facts: SEND_FACTS_ENV,
  key: "LIFE_PI_KEY",
  routing: "LIFE_PI_ROUTING",
} as const;

/** The calls the guard reads, as the hook's matcher names them. */
const GUARDED = new RegExp(`^(${SEND_GUARD_HOOK.matcher})$`);

/** A pi tool call as the guard reads Claude's: pi's `bash` is Claude's `Bash`; MCP tools share the `mcp__<server>__<tool>` shape. */
export const guardedCallOf = (toolName: string, input: unknown) => ({
  tool_input: input,
  tool_name: toolName === "bash" ? "Bash" : toolName,
});

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Life's pi extension needs ${name}`);
  }
  return value;
};

export default function lifeDesk(pi: ExtensionAPI) {
  const env = PI_EXTENSION_ENV;
  const routing = JSON.parse(required(env.routing)) as Record<string, unknown>;
  // The provider key is read once and leaves the environment, so no command the agent runs inherits it.
  const key = required(env.key);
  delete process.env[env.key];
  // A repo's own `.pi` (extensions, MCP servers, settings) never loads beside this one: it could rewrite the routing.
  pi.on("project_trust", () => ({ trusted: "no" }));
  pi.on("before_provider_headers", (event) => {
    event.headers.authorization = null;
    event.headers.Authorization = `Bearer ${key}`;
  });
  pi.registerMcpServer("desk", {
    exposure: "direct",
    headers: { Authorization: `Bearer ${required(env.doorKey)}` },
    url: required(env.doorUrl),
  });
  pi.registerCommand(PI_EXTENSION_COMMAND, {
    description: "Life's desk: the send guard, the door and the routing",
    handler: async () => undefined,
  });
  pi.on("tool_call", (event) => {
    const call = guardedCallOf(event.toolName, event.input);
    if (!GUARDED.test(call.tool_name)) {
      return;
    }
    const why = sendRefusalOf(call, JSON.parse(required(env.facts)));
    return why ? { block: true, reason: why } : undefined;
  });
  pi.on("before_provider_request", (event) => ({
    ...(event.payload as object),
    provider: routing,
  }));
}
