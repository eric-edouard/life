import { z } from "zod";

// Life's fixed names, which its settings use too: the model engines, the sources, the agent's word.

/**
 * The model engine he chooses for every step (apps/server/src/models/llm.ts, `bun life engine`); the bench names one
 * per run (`LIFE_LLM`). claude and codex: the owner's subscriptions, through their CLIs; anthropic, openai and
 * allmodels: an API key (each provider's `key` in `PROVIDERS`).
 */
export const Engine = z.enum([
  "claude",
  "codex",
  "anthropic",
  "openai",
  "allmodels",
]);

export type Engine = z.infer<typeof Engine>;

/**
 * The word stored for his agent, whatever its name: an ask's `target`, its source's name and its units' sender. Never
 * shown (what Life shows is `agentName`).
 */
export const AGENT_WORD = "agent";

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
