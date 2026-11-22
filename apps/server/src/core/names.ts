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

/**
 * The line that ends an agent's own post on GitHub, on a repo he listed for it (`desk.agentPostRepos`): the send guard
 * lets no other post through, and the GitHub source reads a post ending with it as his agent's, not his.
 */
export const AGENT_POST_SIGNATURE =
  "— Posted by an AI agent for this account, not reviewed before posting.";

/**
 * His connector's tools that write (registered with `readOnlyHint` false, `host/http/mcp.ts`; its test checks): the send
 * guard refuses them to an agent on any server but its desk door, so an agent never writes as him.
 */
export const CONNECTOR_WRITES = [
  "answer_check",
  "ask_main_session",
  "change_appointment",
  "change_directory_entry",
  "change_registered_agent",
  "change_todo_item",
  "correct_memory",
  "request_decision",
  "tell_life",
];

/** The built-in agent his words about his registered agents are asked of (`change_registered_agent`): the desk, which keeps its own list. */
export const DESK_AGENT = "desk";

/** Who asks Life's own checks (its guesses). */
export const LIFE_ASKER = "life";

/** Who asked a decision from his own app's token (no agent claim): a role, like `LIFE_ASKER`, never an agent's name. */
export const OWNER_ASKER = "owner";

/** The askers that are roles, not agents: none may name one of his agents, or it would read and withdraw their cards. */
export const ROLE_ASKERS = [DESK_AGENT, OWNER_ASKER, LIFE_ASKER];

/** What a check is, for counting: a decision, an ending, a new matter, a guessed person, a Contacts card Life cannot place (`contacts card`), a name it cannot place, a voice, a guess that may be someone else going by its whole name (`same person`), a matter's step that is his (`your move`), someone of his directory who may be at an organization of it (`at organization`). */
export const CheckGroup = z.enum([
  "decision",
  "ending",
  "new matter",
  "guessed person",
  "contacts card",
  "name",
  "voice",
  "same person",
  "your move",
  "at organization",
]);
export type CheckGroup = z.infer<typeof CheckGroup>;

/** What his notification settings are kept by: a check's group, a decision with a draft apart (`notifyKindOf`, `host/card-push.ts`), and an appointment Life added to his calendar. */
export const NotifyKind = z.enum([
  ...CheckGroup.options,
  "decision with a draft",
  "calendar",
]);
export type NotifyKind = z.infer<typeof NotifyKind>;

/** How a kind's new card reaches his phone: not at all, silently (Notification Center only), as a normal push, or time-sensitive (a card with a deadline, only within 3 hours of it). */
export const NotifyLevel = z.enum(["off", "quiet", "normal", "urgent"]);
export type NotifyLevel = z.infer<typeof NotifyLevel>;

/** The runtimes the desk drives (`desk/runtimes/`), by name. */
export const RuntimeName = z.enum(["claude", "codex", "pi"]);
export type RuntimeName = z.infer<typeof RuntimeName>;

/** A web search provider an agent of his own Life on pi may ask (`web_search`, `desk/runtimes/web-tools.ts`). */
export const WebSearchProvider = z.enum(["brave", "perplexity-search"]);
export type WebSearchProvider = z.infer<typeof WebSearchProvider>;

/** A runtime as he reads it, by its name: the program, as its maker calls it. */
export const RUNTIME_WORDS: Record<RuntimeName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "pi",
};

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
