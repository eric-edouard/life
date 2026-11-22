import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { CallUsage } from "./contract";
import { WEB_SEARCH } from "./web-tools";

// `subagent` for an agent of his own Life on pi (Claude Code's Task tool): a child session in the same pi process,
// through pi's own SDK (the copy pi hands its extensions), given Life's extension as an object (`factory`, no door and
// no connector reads), so the send guard is in the child by construction and the provider key never enters an
// environment. The child runs on the parent's model and thinking, in the parent's folder, never trusts the folder's
// `.pi`, has no `subagent` of its own, and keeps nothing (an in-memory session). Its calls' usage, and its searches' prices, come back in the
// tool result's `details` (`SpentDetails`), which the pi runtime adds to the turn's (`pi-runtime.ts`).

/** The tool's name: the child has none of it. */
export const SUBAGENT = "subagent";

/** Life's own tools whose result's `details` is a spend: this one's child calls and searches, `web_search`'s paid requests. */
export const SPENDING_TOOLS = [SUBAGENT, WEB_SEARCH];

/** A spending tool's `details`: model calls' usage, and each paid search's price (undefined when unknown, never guessed). */
export interface SpentDetails {
  searchUsd?: (number | undefined)[];
  usage?: CallUsage[];
}

/** Registers `subagent`, its child sessions built on `factory`. */
export function registerSubagent(pi: ExtensionAPI, factory: ExtensionFactory) {
  pi.registerTool({
    description:
      "Hand a self-contained task to a subagent: a fresh session with the same tools (no door) that works it alone and returns its final answer. Use it for research or work that would fill your context.",
    async execute(_id, params: { task: string }, signal, _update, ctx) {
      // Life's model only: with none, pi would fall back to any provider his environment holds a key for.
      if (!ctx.model) {
        throw new Error(
          "a subagent runs on the agent's own model, and it has none"
        );
      }
      const sdk = await import("@earendil-works/pi-coding-agent");
      const agentDir = sdk.getAgentDir();
      const settingsManager = sdk.SettingsManager.create(ctx.cwd, agentDir, {
        projectTrusted: false,
      });
      const resourceLoader = new sdk.DefaultResourceLoader({
        agentDir,
        cwd: ctx.cwd,
        extensionFactories: [factory],
        settingsManager,
      });
      await resourceLoader.reload();
      const { session } = await sdk.createAgentSession({
        agentDir,
        cwd: ctx.cwd,
        model: ctx.model,
        resourceLoader,
        sessionManager: sdk.SessionManager.inMemory(ctx.cwd),
        settingsManager,
        thinkingLevel: pi.getThinkingLevel(),
      });
      const usage: CallUsage[] = [];
      const searchUsd: (number | undefined)[] = [];
      let answer = "";
      session.subscribe((e) => {
        // The child's own searches are its spend too: none of its events reaches the runtime's reader.
        if (
          e.type === "tool_execution_end" &&
          SPENDING_TOOLS.includes(e.toolName)
        ) {
          const d: SpentDetails | undefined = e.result?.details;
          usage.push(...(d?.usage ?? []));
          searchUsd.push(...(d?.searchUsd ?? []));
        }
        if (e.type === "message_end" && e.message.role === "assistant") {
          usage.push(e.message.usage);
          answer =
            e.message.content
              .flatMap((c) => (c.type === "text" ? [c.text] : []))
              .join("") ||
            (e.message.errorMessage ?? "");
        }
      });
      const stop = () => session.abort();
      signal?.addEventListener("abort", stop);
      let why = "";
      try {
        if (!signal?.aborted) {
          await session.prompt(params.task);
        }
      } catch (e) {
        why = String(e);
      } finally {
        signal?.removeEventListener("abort", stop);
        session.dispose();
      }
      // Its usage comes back however it ended: the turn counts what it spent.
      return {
        content: [
          { text: answer || why || "(no answer)", type: "text" as const },
        ],
        details: { searchUsd, usage } satisfies SpentDetails,
      };
    },
    label: "Subagent",
    name: SUBAGENT,
    parameters: {
      properties: {
        task: {
          description:
            "The whole task, with everything the subagent needs to know",
          type: "string",
        },
      },
      required: ["task"],
      type: "object",
    } as never,
  });
}
