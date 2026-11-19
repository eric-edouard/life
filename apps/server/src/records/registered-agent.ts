import { z } from "zod";

// The desk's shapes (apps/server/src/desk/, docs/glossary.md): a registered agent's wait and what its turns report.

/** Whether a client's `text_matches` compiles. */
const isPattern = (source: string) => {
  try {
    return Boolean(new RegExp(source));
  } catch {
    return false;
  }
};

/**
 * Which events an agent waits for: one filter for the connector's poll and a registered agent's wait, matched in one
 * place (`matcherOf` over `Matchable`, `host/events.ts`, whose rules say what a field an event cannot answer does).
 * Messages (`message.received`): who wrote it, in which apps or chat, his own or others', and a pattern on its text;
 * the calls that ended in the same chats (`call.ended`); and, for a registered agent's wait, an event channel's
 * events, by name in `channels`, by `quantity` between `above` and `below`, and by a pattern (a payment's,
 * `payment.booked`). The connector's poll takes the message keys only.
 */
export const EventFilter = z
  .object({
    above: z
      .number()
      .optional()
      .describe("With `quantity`: only when it is more than this"),
    below: z
      .number()
      .optional()
      .describe("With `quantity`: only when it is less than this"),
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
    quantity: z
      .string()
      .optional()
      .describe(
        "The name of a quantity the event holds, compared with `above` and `below`"
      ),
    text_matches: z
      .string()
      .max(200)
      .refine(isPattern, "not a regular expression")
      .optional()
      .describe("A regular expression its text must match, any case"),
  })
  .strict();
export type EventFilter = z.infer<typeof EventFilter>;

/** What an active registered agent waits for: messages, and one deadline (`until`), with its reason. */
export const AgentWait = z
  .object({
    events: z.array(EventFilter).max(20),
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
