import { z } from "zod";

// Life's fixed names, which its settings use too: the model engines, the sources, the agent's word.

/**
 * The model engine he chooses for every step (apps/server/src/models/llm.ts, `bun life engine`); the bench names one
 * per run (`LIFE_LLM`). claude and codex: the owner's subscriptions, through their CLIs; allmodels: his API key
 * (`ALLMODELS_API_KEY`).
 */
export const Engine = z.enum(["claude", "codex", "allmodels"]);

export type Engine = z.infer<typeof Engine>;

/**
 * The word stored for his agent, whatever its name: an ask's `target`, its source's name and its units' sender. Never
 * shown (what Life shows is the agent's name, an ask's `after.agent`).
 */
export const AGENT_WORD = "agent";

/** Where a unit or an observation comes from. */
export const SourceName = z.enum([
  "lifelog",
  "line",
  "instagram",
  "linkedin",
  "telegram",
  "whatsapp",
  "imessage",
  "mail",
  "git",
  "screen",
  "notes",
  "claude",
  "chatgpt",
  "told",
  AGENT_WORD,
]);

export type SourceName = z.infer<typeof SourceName>;
