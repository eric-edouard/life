import { z } from "zod";
import { settings } from "../core/settings";

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

/**
 * His word about a registered agent (`change_registered_agent`), as stored in his ask for the desk (`after.agentChange`):
 * start one on a subject (exactly one of a matter's `steps`, its anchors, or a `project`), stop, resume, re-point,
 * change its model, or hand it over. The desk applies it once (`desk/agent-changes.ts`).
 */
export const AgentChange = z
  .object({
    action: z.enum([
      "start",
      "stop",
      "resume",
      "re_point",
      "change_model",
      "hand_over",
    ]),
    agent: z
      .string()
      .regex(/^agt_[0-9a-f]+$/)
      .optional(),
    effort: z.string().min(1).optional(),
    folder: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    project: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    steps: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type AgentChange = z.infer<typeof AgentChange>;

/** The runtime a start names, else the desk's default. */
export const runtimeOf = (c: Pick<AgentChange, "runtime">) =>
  c.runtime ?? settings().desk?.defaultRuntime;
