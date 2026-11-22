import type {
  ExtensionAPI,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

// `subagent` for an agent of his own Life on pi (Claude Code's Task tool): a child session in the same pi process,
// through pi's own SDK (the copy pi hands its extensions), given Life's extension as an object (`factory`, no door and
// no connector reads), so the send guard is in the child by construction and the provider key never enters an
// environment. The child runs on the parent's model and thinking, in the parent's folder, never trusts the folder's
// `.pi`, has no `subagent` of its own, and keeps nothing (an in-memory session). Its calls' usage comes back in the
// tool result's `details.usage`, which the pi runtime adds to the turn's (`pi-runtime.ts`).

/** One model call's usage, as pi's assistant messages carry it. */
export interface CallUsage {
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number; totalFromProvider?: boolean };
  input: number;
  output: number;
  totalTokens: number;
}

/** The tool's name: the child has none of it. */
export const SUBAGENT = "subagent";

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
      let answer = "";
      session.subscribe((e) => {
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
        details: { usage },
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
