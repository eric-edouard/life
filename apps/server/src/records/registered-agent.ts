import { z } from "zod";

// The desk's shapes (apps/server/src/desk/, docs/glossary.md): a registered agent's wait and what its turns report.

/**
 * Which messages an agent waits for (`message.received`, `host/events.ts`): who wrote it, in which apps or chat, his own
 * or others'. Events carry no text, so no filter reads it.
 */
export const MessageFilter = z
  .object({
    channels: z
      .array(z.string())
      .optional()
      .describe("Only these apps; every one by default"),
    chat: z
      .string()
      .optional()
      .describe("Only this chat: its key, as `read_chats` gives it"),
    from_me: z
      .boolean()
      .default(false)
      .describe("His own messages instead of everyone else's"),
    person: z
      .string()
      .optional()
      .describe(
        "Who: a name, handle or person id. Matches who wrote it; on his own messages, the other side of a 1:1 chat"
      ),
  })
  .strict();
export type MessageFilter = z.infer<typeof MessageFilter>;

/** What an active registered agent waits for: messages, and one deadline (`until`), with its reason. */
export const AgentWait = z
  .object({
    events: z.array(MessageFilter).max(20),
    reason: z.string().min(1).max(200),
    until: z.iso.datetime(),
  })
  .strict();
export type AgentWait = z.infer<typeof AgentWait>;

/** A registered agent's status: `active` (a turn running or waiting), `stopped` (restarts on his word only), or done with. */
export type AgentStatus = "active" | "stopped" | "handed_over" | "ended";

/** How an agent turn ended: it set a wait or finished, the desk set the default wait, or it failed (its process failed, or ended unheard). */
export type TurnOutcome = "waited" | "finished" | "default_wait" | "failed";
