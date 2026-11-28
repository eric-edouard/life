import { z } from "zod";
import type { AgentRole } from "../core/names";

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
 * events, by name in `channels`, by `quantity` between `above` and `below`, by a pattern (a payment's,
 * `payment.booked`; an arrival's line, `stay.arrived`; a GitHub activity's title and body, `github.activity`), by a
 * place (`latitude`, `longitude`, `radius_m`: an arrival's point within the radius), and by a GitHub `repo`. The
 * connector's poll takes the message keys only.
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
    latitude: z
      .number()
      .min(-90)
      .max(90)
      .optional()
      .describe("With `longitude`: only events within `radius_m` of here"),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .optional()
      .describe("With `latitude`: only events within `radius_m` of here"),
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
    radius_m: z
      .number()
      .positive()
      .max(5000)
      .optional()
      .describe(
        "With `latitude` and `longitude`: how near, in meters (100 by default, as `read_places_visited`'s `radiusM`)"
      ),
    repo: z
      .string()
      .regex(/^[\w.-]+\/(?:[\w.-]+|\*)$/, "a repo is `owner/name` or `owner/*`")
      .optional()
      .describe(
        "With `github_activity`: a GitHub repo, `owner/name`, or an owner's repos (the first 100), `owner/*`"
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

/** An assignment's quiet line (docs/glossary.md): what its agent does now and when it expects the work done, given on `set_wait` or `write_notes`; `doing` given replaces both. */
export const QuietLine = z.object({
  doing: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "What you are doing now, in a few plain words he reads on his phone (`Sorting 2023`); replaces your last line with `eta`"
    ),
  eta: z.iso
    .datetime()
    .optional()
    .describe("When you expect the whole work done (ISO), with `doing`"),
});
export type QuietLine = z.infer<typeof QuietLine>;

/** A registered agent's status: `active` (a turn running or waiting), `stopped` (restarts on his word only), or done with. */
export type AgentStatus = "active" | "stopped" | "handed_over" | "ended";

/** Whether an agent in `role` takes no subject but its own (no move to it, no re-point): the caretaker, the main session. */
export const hasFixedSubject = (role: AgentRole | null) =>
  role === "caretaker" || role === "main";

/** Whether an agent in `role` is woken only by his words (the main session): never by the clock, so it holds no wait. */
export const isWokenOnlyByHisWords = (role: AgentRole | null) =>
  role === "main";

/** Who opened an assignment: he did (`owner`: his word, his Start), or the desk did itself (`desk`, the hand-out). */
export type OpenedBy = "owner" | "desk";

/** How an agent turn ended: it set a wait or finished, the desk set the default wait, it failed (its process failed, or ended unheard), it was a move's notes turn (`notes`, however its run ended), the main session replied to his words (`replied`), or the desk helper was stopped under it (`cut`: not a failure, its wake is owed again). */
export type TurnOutcome =
  | "replied"
  | "waited"
  | "finished"
  | "default_wait"
  | "failed"
  | "notes"
  | "cut";

/**
 * His word about a registered agent (`change_registered_agent`), as stored in his ask for the desk (`after.agentChange`):
 * start one on a subject (exactly one of a matter's `steps`, its anchors, which go to the agent that takes the matter,
 * `agentForOf`; a `project`; or `role` `personal`, the Personal agent), stop, resume, re-point, rename (`name`), change its
 * model, move (`hand_over`: a matter's `steps` to a new agent on a `runtime` or to the `agent` he names; or an `agent`
 * to a `runtime`), or open its session on his Mac (`continue_on_mac`, his token only). The desk applies it once (`desk/agent-changes.ts`, a move in `desk/agent-moves.ts`).
 */
export const AgentChange = z
  .object({
    action: z.enum([
      "start",
      "stop",
      "resume",
      "re_point",
      "rename",
      "change_model",
      "hand_over",
      "continue_on_mac",
    ]),
    agent: z
      .string()
      .regex(/^agt_[0-9a-f]+$/)
      .optional(),
    effort: z.string().min(1).optional(),
    folder: z.string().min(1).optional(),
    /** The matter he named, by its id, beside its `steps`: kept on the assignment (`matter_id`), it settles a tie between matters sharing steps. */
    matter: z.string().min(1).optional(),
    model: z.string().min(1).optional(),
    name: z.string().min(1).max(60).optional(),
    project: z.string().min(1).optional(),
    role: z.enum(["personal"]).optional(),
    runtime: z.string().min(1).optional(),
    steps: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();
export type AgentChange = z.infer<typeof AgentChange>;
