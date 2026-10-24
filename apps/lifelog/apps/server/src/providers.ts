// The text model for conversation intelligence, asked for a strict JSON schema: the Mac,
// on the owner's subscription, and nothing else. Only transcript text, speaker names, capture
// times and the owner's title are sent (docs/providers.md). Tests pass a fake `Provider`.

import type { MacEngine } from "@lifelog/db/schema";
import type { Late, MacSocket } from "./mac-socket";
import { switches } from "./switches";

const MAX_OUTPUT_TOKENS = 16_000;
// What the Mac helper runs (apps/mac-quiet): Sonnet for every call (owner, October 11: one
// model for titles, recaps and who's who; Haiku named people too unreliably).
const MAC_MODELS = {
  claude: "claude-sonnet-5-5",
  codex: "gpt-6.1-sol",
} as const;
const CODEX_EFFORT = "medium";
const macProvenance = (engine: MacEngine) => ({
  model: MAC_MODELS[engine],
  name: engine === "codex" ? ("codex" as const) : ("claude-code" as const),
  reasoningEffort: engine === "codex" ? CODEX_EFFORT : null,
});

// The Mac went away (asleep, offline, signed out, at its limit) before answering: the run
// waits for it rather than failing.
export class MacGone extends Error {
  override name = "MacGone";
}

export interface ModelCall {
  schema: Record<string, unknown>;
  system: string;
  user: string;
}

export interface ModelReply {
  inputTokens: number;
  outputTokens: number;
  text: string;
}

export interface Provider {
  // `late` gets an answer that comes after the call failed (the Mac's socket: mac-socket.ts).
  call: (call: ModelCall, late?: Late) => Promise<ModelReply>;
  model: string;
  // Only the Mac's engines: runs on a paid API are history (intelligence_provider keeps them).
  name: ReturnType<typeof macProvenance>["name"];
  // False while calls can't run now (the Mac away): runs wait instead. Absent: always ready.
  ready?: () => boolean;
  reasoningEffort?: string | null;
  // Freeze the selected engine before a run starts, including its retries.
  snapshot?: () => Provider;
}

// The Mac helper runs the call with Codex or Claude Code on the owner's subscription (mac-socket.ts), so
// it costs nothing. Ready only while the Mac is able; otherwise runs wait for it. The only
// provider the server summarizes with: summaries never spend API credits. Never ready while
// the AI switch is off (switches.ts): runs wait as if the Mac were away.
export function macProvider(
  mac: Pick<MacSocket, "able" | "llm">,
  paused: () => boolean = () => false,
  engine: () => MacEngine = () => switches().engine
): Provider {
  const selected = (choice: MacEngine): Provider => ({
    ...macProvenance(choice),
    call: ({ schema, system, user }, late) =>
      paused()
        ? Promise.reject(new MacGone("AI is paused"))
        : mac.llm(
            {
              effort: choice === "codex" ? CODEX_EFFORT : undefined,
              engine: choice,
              maxTokens: MAX_OUTPUT_TOKENS,
              model: MAC_MODELS[choice],
              prompt: user,
              schema,
              system,
            },
            late
          ),
    ready: () => !paused() && mac.able(choice),
  });
  return {
    call: (call, late) => selected(engine()).call(call, late),
    get model() {
      return MAC_MODELS[engine()];
    },
    get name() {
      return macProvenance(engine()).name;
    },
    ready: () => !paused() && mac.able(engine()),
    get reasoningEffort() {
      return macProvenance(engine()).reasoningEffort;
    },
    snapshot: () => selected(engine()),
  };
}
