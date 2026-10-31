import { z } from "zod";
import { DAY, iso, MIN } from "../core/clock";
import { asHeard, type Settings, settings } from "../core/settings";
import { lastUpdate, type Task } from "./ledger";
import { clip } from "./units";

// The agent's tasks as the ledger holds them (memory/ledger.jsonl): how an ask is told from his words ("hey <agent>"),
// its name, the updates the agent may write, and where each task stands. host/agent.ts writes them and chases.

const SPACES = /\s+/;
/** One wake word as lifelog may write it: its words, with any spaces or punctuation between them. */
const phrase = (w: string) =>
  w.trim().split(SPACES).map(RegExp.escape).join(String.raw`\W+`);
/**
 * "hey" as lifelog writes it, then the spaces and punctuation after it: "Hej" on 21 Oct (audit 4), never the end of a
 * longer word. Shared by both wakes.
 */
const GREETING = String.raw`\b(?:hey|hej|hei|hé|ey)\W+`;
let made: { of: unknown; wakes: ReturnType<typeof wakesOf> } | undefined;
/** The wakes of this process's agents (made once per settings read). */
export function wakes() {
  const { agents } = settings();
  const m =
    made && made.of === agents
      ? made
      : { of: agents, wakes: wakesOf(agents ?? {}) };
  made = m;
  return m.wakes;
}
function wakesOf(agents: NonNullable<Settings["agents"]>) {
  const all = Object.entries(agents);
  /** Each word as heard, to its agent; and whether it is its name, not a mishearing. */
  const words = new Map<string, { agent: string; isName: boolean }>(
    all.flatMap(([agent, a]) => [
      ...a.misheard.map((w): [string, { agent: string; isName: boolean }] => [
        asHeard(w),
        { agent, isName: false },
      ]),
      ...a.wake.map((w): [string, { agent: string; isName: boolean }] => [
        asHeard(w),
        { agent, isName: true },
      ]),
    ])
  );
  const any = all.flatMap(([, a]) => [...a.wake, ...a.misheard]).map(phrase);
  /** A greeting then an agent's name or a mishearing of it, whatever the case; with no agent, nothing wakes. */
  const wake = new RegExp(
    any.length > 0 ? String.raw`${GREETING}(${any.join("|")})\b` : "(?!)",
    "i"
  );
  return {
    /** The agent a wake word wakes. */
    agentOf: (word: string) => words.get(asHeard(word))?.agent,
    /**
     * Whether a wake word is an agent's name, not a mishearing (the `misheard` setting: a mishearing lifelog made on
     * 20 Oct, audit 4, or a real name people he knows go by). A misheard one wakes only on his own turn, as `low` (the
     * agent confirms with him).
     */
    isName: (word: string) => words.get(asHeard(word))?.isName === true,
    /** Everything up to "hey <agent>" and the spaces and punctuation after it: the title is his words from there. */
    toWake: new RegExp(String.raw`^.*?${wake.source}[\s\p{P}]*`, "isu"),
    wake,
  };
}
/** A task's name: its title, else his words from "hey <agent>" on. */
export const titleOf = (t: { quote: string; title?: string }) =>
  clip(t.title ?? (t.quote.replace(wakes().toWake, "") || t.quote), 80);
/** The agent a task is for (its ask's `after.agent`). */
export const agentOf = (t: Task) => String(t.ask.after.agent);
/** An ask is due to be claimed 30 min after it was recorded (since events, a healthy claim takes 3 to 27 min, a median of 7). */
const CLAIM_MS = 30 * MIN;
export const closed = (s: TaskState) => s === "done" || s === "dropped";
/** Where a task stands: its last update (`end`), deadline (an open one's: 30 min after it was recorded), steps. */
export function standing(t: Task) {
  const last = lastUpdate(t);
  const end: Partial<Update> = last?.after ?? {};
  const since = last?.at ?? t.ask.at;
  const state = end.state ?? ("open" as TaskState);
  const deadline = last ? end.deadline : iso(Date.parse(since) + CLAIM_MS);
  return {
    deadline,
    end,
    since,
    state,
    steps: (t.lines.findLast((u) => u.kind === "update" && u.after.steps)?.after
      .steps ?? []) as Step[],
    /** The agent's last word: the outcome or reason once closed. */
    word: end.outcome ?? end.reason ?? end.question ?? end.note,
  };
}
/** Closed over a day ago: out of the lists, and its board item left to him. */
export const settled = (s: { since: string; state: TaskState }, now: number) =>
  closed(s.state) && now - Date.parse(s.since) > DAY;
/** A task's name, as the board, the email and `search` show it. */
export const nameOf = (t: Task) =>
  titleOf({
    quote: t.ask.instruction.quote,
    title: t.ask.after.title as string | undefined,
  });
const Text = z.string().min(1).max(2000);
const Step = z.object({
  done: z.boolean(),
  title: z.string().trim().min(1).max(200),
});
const Instant = z.iso.datetime({ offset: true });
/** One update from the agent (the connector's `update_agent_task`): on `task`, or a new one from his words (`said`) or a split (`parent`). */
export const Update = z.object({
  at: Instant.optional().describe("said: when he sent it"),
  deadline: Instant.optional(),
  note: Text.optional(),
  on: z.string().max(200).optional().describe("What or whom it waits for"),
  outcome: Text.optional(),
  parent: z.string().optional().describe("Splits this task: with `title`"),
  question: Text.optional().describe("waiting-owner: what you asked him"),
  reason: Text.optional(),
  said: Text.optional().describe("A new task: his words, verbatim"),
  seal: z
    .string()
    .optional()
    .describe("The `seal` from `read_open_agent_tasks`"),
  state: z.enum(["working", "waiting-owner", "done", "dropped"]),
  steps: z.array(Step).max(30).optional().describe("The full list every time"),
  taken: z
    .boolean()
    .optional()
    .describe("true on the first update only: you take the task"),
  task: z.string().optional().describe("The task's id"),
  title: z.string().trim().min(1).max(200).optional().describe("The part"),
});

type Step = z.infer<typeof Step>;
export type Update = z.infer<typeof Update>;
export type TaskState = Update["state"] | "open";
