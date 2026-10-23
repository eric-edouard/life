import { z } from "zod";

// Life's fixed names, which its settings use too: the model engines and runners, the sources, the agent's word.

/**
 * The model runner he chooses for every step (apps/server/src/models/llm.ts, `bun life engine`). claude and codex: the
 * owner's subscriptions, through their CLIs, on the Mac host; openrouter: a server's, with his key
 * (`OPENROUTER_API_KEY`); anthropic and openai: an API key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`), for an install that
 * has neither.
 */
export const Engine = z.enum([
  "claude",
  "codex",
  "openrouter",
  "anthropic",
  "openai",
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
