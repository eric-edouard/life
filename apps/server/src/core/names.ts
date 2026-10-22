import { z } from "zod";

// Life's fixed names, which its settings use too: the model engines and runners, the sources, the agent's word.

/**
 * The model runner he chooses for every step (apps/server/src/models/llm.ts, `bun life engine`). claude and codex: the
 * owner's subscriptions, through their CLIs; anthropic and openai: an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`),
 * for an install that has none.
 */
export const Engine = z.enum(["claude", "codex", "anthropic", "openai"]);
export type Engine = z.infer<typeof Engine>;

/** What can run one call: his engines, and OpenRouter for the bench alone (`llmOverride`, only on a copy of his data). */
export const Runner = z.enum([...Engine.options, "openrouter"]);
export type Runner = z.infer<typeof Runner>;

/**
 * The word stored for his agent, whatever its name: an ask's `target`, its source's name and its units' sender. Kept
 * as first written, as stored data is append-only; never shown (what Life shows is `agentName`).
 */
export const AGENT_WORD = "atlas";

/** Where a unit or an observation comes from. */
export const SourceName = z.enum([
  "lifelog",
  "beeper",
  "whatsapp",
  "imessage",
  "mail",
  "git",
  "notes",
  "claude",
  "chatgpt",
  AGENT_WORD,
]);
export type SourceName = z.infer<typeof SourceName>;
