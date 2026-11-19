import { z } from "zod";

// Life's fixed names, which its settings use too: the model engines, the sources, the agent's word.

/**
 * The model engine he chooses for every step (apps/server/src/models/llm.ts, `bun life engine`); the bench names one
 * per run (`LIFE_LLM`). claude and codex: the owner's subscriptions, through their CLIs; allmodels and openrouter: his
 * API keys, one per router of the engine's routes (`routesOf`).
 */
export const Engine = z.enum(["claude", "codex", "allmodels", "openrouter"]);

export type Engine = z.infer<typeof Engine>;

/**
 * The word stored for his agent, whatever its name: an ask's `target`, its source's name and its units' sender. Never
 * shown (what Life shows is the agent's name, an ask's `after.agent`).
 */
export const AGENT_WORD = "agent";

/** The built-in agent his words about his registered agents are asked of (`change_registered_agent`): the desk, which keeps its own list. */
export const DESK_AGENT = "desk";

/** Who asks Life's own checks (its guesses). */
export const LIFE_ASKER = "life";

/** Who asked a decision from his own app's token (no agent claim): a role, like `LIFE_ASKER`, never an agent's name. */
export const OWNER_ASKER = "owner";

/** The askers that are roles, not agents: none may name one of his agents, or it would read and withdraw their cards. */
export const ROLE_ASKERS = [DESK_AGENT, OWNER_ASKER, LIFE_ASKER];

/** The runtimes the desk drives (`desk/runtimes/`), by name. */
export const RuntimeName = z.enum(["claude", "codex"]);
export type RuntimeName = z.infer<typeof RuntimeName>;

/** Where a unit or an observation comes from. */
export const SourceName = z.enum([
  "lifelog",
  "line",
  "instagram",
  "messenger",
  "linkedin",
  "telegram",
  "whatsapp",
  "imessage",
  "phone",
  "mail",
  "github",
  "git",
  "screen",
  "apple-health",
  "photos",
  "notes",
  "claude",
  "chatgpt",
  "told-life",
  AGENT_WORD,
]);

export type SourceName = z.infer<typeof SourceName>;
