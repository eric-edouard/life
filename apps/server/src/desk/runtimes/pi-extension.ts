import type {
  ExtensionAPI,
  ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import { SEND_FACTS_ENV, SEND_GUARD_HOOK, sendRefusalOf } from "../send-guard";

// The extension every pi session of the desk loads (`pi -e`, `pi-runtime.ts`): inside the pi process, before each tool
// call, Life's send guard (`send-guard.ts`), on the calls Claude's and Codex's hook reads (`SEND_GUARD_HOOK.matcher`);
// the agent's door as MCP server `desk`; and Life's model provider, `PI_PROVIDER`, whose models carry Life's routing
// (`compat.openRouterRouting`), which pi puts on every request of the provider, compaction's included (the owner's
// decision 3 of 22 Nov 2026, `docs/plans/pi-runtime.md`). Everything comes from the spawn's environment. pi blocks a
// call whose `tool_call` handler throws, so a guard that cannot decide refuses. pi only logs an extension that fails to
// load: the runtime checks `PI_EXTENSION_COMMAND` before it prompts.

/** The command this extension registers: the runtime starts no turn on a pi that does not list it. */
export const PI_EXTENSION_COMMAND = "life-desk";

/** The provider this extension registers: the runtime runs pi with `--provider` this. */
export const PI_PROVIDER = "life";

/** What the runtime puts in pi's environment for this extension. */
export const PI_EXTENSION_ENV = {
  doorKey: "LIFE_DESK_KEY",
  doorUrl: "LIFE_DESK_URL",
  facts: SEND_FACTS_ENV,
  key: "LIFE_PI_KEY",
  provider: "LIFE_PI_PROVIDER",
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

const required = (name: string) => {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Life's pi extension needs ${name}`);
  }
  return value;
};

export default function lifeDesk(pi: ExtensionAPI) {
  const env = PI_EXTENSION_ENV;
  // The key leaves the environment once read, so no command the agent runs inherits it.
  const apiKey = required(env.key);
  delete process.env[env.key];
  pi.registerProvider(PI_PROVIDER, {
    ...(JSON.parse(required(env.provider)) as PiProvider),
    apiKey,
  });
  // A repo's own `.pi` (extensions, MCP servers, settings) never loads beside this one: it could rewrite a request.
  pi.on("project_trust", () => ({ trusted: "no" }));
  pi.registerMcpServer("desk", {
    exposure: "direct",
    headers: { Authorization: `Bearer ${required(env.doorKey)}` },
    url: required(env.doorUrl),
  });
  pi.registerCommand(PI_EXTENSION_COMMAND, {
    description: "Life's desk: the send guard, the door and Life's provider",
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
}
