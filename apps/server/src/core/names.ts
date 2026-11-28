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
  "change_setting",
  "change_todo_item",
  "correct_memory",
  "delete_from_memory",
  "request_decision",
  "sign_in_to_network",
  "tell_life",
];

/** The built-in agent his words about his registered agents are asked of (`change_registered_agent`): the desk, which keeps its own list. */
export const DESK_AGENT = "desk";

/**
 * Life's developer contact: where a caretaker's feedback mail goes, a card's draft sent only on his Send (his ruling of
 * 22 Nov 2026: "Bug reports should be an email to me"). Public on purpose: the scrub skips it.
 */
export const DEVELOPER_CONTACT = "feedback@ericedouard.com";

/** Who asks Life's own checks (its guesses). */
export const LIFE_ASKER = "life";

/** Who asked a decision from his own app's token (no agent claim): a role, like `LIFE_ASKER`, never an agent's name. */
export const OWNER_ASKER = "owner";

/** The askers that are roles, not agents: none may name one of his agents, or it would read and withdraw their cards. */
export const ROLE_ASKERS = [DESK_AGENT, OWNER_ASKER, LIFE_ASKER];

/** What a check is, for counting: a decision, an ending, a new matter, a guessed person, a Contacts card Life cannot place (`contacts card`), a name it cannot place, a voice, a guess that may be someone else going by its whole name (`same person`), a matter's step that is his (`your move`), someone of his directory who may be at an organization of it (`at organization`). */
export const CheckGroup = z.enum([
  "fix",
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

/** A reading's level, in the same words wherever a model reads one: the gate's urgency and importance of an agent's card, a step's urgency (`step-readings.ts`). */
export const Level = z.enum(["low", "normal", "high"]);
export type Level = z.infer<typeof Level>;

/** A standing agent's role, one active or stopped at most of each: `personal` (his matters with no project's agent), `caretaker` (fixes what Life got wrong, on his complaint through Ask Life), `main` (the main session: answers his words through Ask Life). */
export const AgentRole = z.enum(["personal", "caretaker", "main"]);
export type AgentRole = z.infer<typeof AgentRole>;

/** The runtimes the desk drives (`desk/runtimes/`), by name. */
export const RuntimeName = z.enum(["claude", "codex", "pi"]);
export type RuntimeName = z.infer<typeof RuntimeName>;
/** pi, pinned in Life: every install runs it, so it is the runtime a start falls to when his settings name none, and the one an agent with no session takes when its own can't run (the owner's word of 22 Nov 2026). */
export const BUILT_IN_RUNTIME: RuntimeName = "pi";

/** A web search provider, by the name his `desk.webSearch` gives it (`web-search/backend.ts`). */
export const WebSearchProviderName = z.enum([
  "brave",
  "perplexity-search",
  "serpapi",
  "serper",
  "tavily",
]);
export type WebSearchProviderName = z.infer<typeof WebSearchProviderName>;

/** A runtime as he reads it, by its name: the program, as its maker calls it. */
export const RUNTIME_WORDS: Record<RuntimeName, string> = {
  claude: "Claude Code",
  codex: "Codex",
  pi: "pi",
};

/** Where a unit or an observation comes from. */
export const SourceName = z.enum([
  "voice",
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
