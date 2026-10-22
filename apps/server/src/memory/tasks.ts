import { z } from "zod";
import { DAY, iso, MIN } from "../core/clock";
import { settings } from "../core/settings";
import { lastUpdate, type Task } from "./ledger";
import { clip } from "./units";

// The agent's tasks as the ledger holds them (memory/actions.jsonl): how an ask is told from his words ("hey <agent>"),
// its name, the updates the agent may write, and where each task stands. host/tasks.ts writes them and chases.

// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).

const SPACES = /\s+/;
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
const NON_WORD = /\W+/g;
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/** One wake word as lifelog may write it: its words, with any spaces or punctuation between them. */
const phrase = (w: string) =>
  w.trim().split(SPACES).map(RegExp.escape).join(String.raw`\W+`);
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/** A wake word as heard, compared: lower case, one space between words. */
const asHeard = (w: string) => w.toLowerCase().replace(NON_WORD, " ").trim();
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
const agentSetting = settings().agent;
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
const NAMES = new Set((agentSetting?.wake ?? []).map(asHeard));
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/**
 * Whether a wake word is the agent's name, not a mishearing (the `misheard` setting: a mishearing lifelog made on 20 Oct,
 * audit 4, or a real name people he knows go by). A misheard one wakes only on his own turn, as `low` (the agent
 * confirms with him).
 */
export const isName = (word: string) => NAMES.has(asHeard(word));
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/**
 * "hey" as lifelog writes it, then the spaces and punctuation after it: "Hej" on 21 Oct (audit 4), never the end of a
 * longer word. Shared by both wakes.
 */
const GREETING = String.raw`\b(?:hey|hej|hei|hé|ey)\W+`;
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
const WAKES = [
  ...(agentSetting?.wake ?? []),
  ...(agentSetting?.misheard ?? []),
].map(phrase);
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/** A greeting then the agent's name or a mishearing of it, whatever the case; with no agent, nothing wakes. */
export const WAKE = new RegExp(
  WAKES.length > 0 ? String.raw`${GREETING}(${WAKES.join("|")})\b` : "(?!)",
  "i"
);
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/** "hey Life": his marker that what follows is worth remembering, for memory only (`marksIn`, hear.ts); "Live" is lifelog's misspelling. */
export const MARK = new RegExp(String.raw`${GREETING}li[fv]e\b`, "i");
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/** Everything up to "hey <agent>" and the spaces and punctuation after it: the title is his words from there. */
const TO_WAKE = new RegExp(String.raw`^.*?${WAKE.source}[\s\p{P}]*`, "isu");
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/** A task's name: its title, else his words from "hey <agent>" on. */
export const titleOf = (t: { quote: string; title?: string }) =>
  clip(t.title ?? (t.quote.replace(TO_WAKE, "") || t.quote), 80);
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
/** An ask is due to be claimed 30 min after it was recorded (since events, a healthy claim takes 3 to 27 min, a median of 7). */
const CLAIM_MS = 30 * MIN;
// The agent's tasks: each ask (his "hey <agent>", `bun life ask`, or the agent's `task` from his chat words or a split) is a task in memory/actions.jsonl until the agent closes it
// done or dropped. Its own lines: the agent's updates (the connector's `task`) and replies to him (`reply`); Life's nudges and
// his steers (until 20 Oct) are only history. What needs him is `escalation`, emailed once (`chase`).
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
/** One update from the agent (the connector's `task`): on `task`, or a new one from his words (`said`) or a split (`parent`). */
export const Update = z.object({
  at: Instant.optional().describe("said: when he sent it"),
  claim: z.boolean().optional().describe("true on the first update only"),
  deadline: Instant.optional(),
  note: Text.optional(),
  on: z.string().max(200).optional().describe("What or whom it waits for"),
  outcome: Text.optional(),
  parent: z.string().optional().describe("Splits this task: with `title`"),
  question: Text.optional().describe("waiting-eric: what you asked him"),
  reason: Text.optional(),
  said: Text.optional().describe("A new task: his words, verbatim"),
  seal: z.string().optional().describe("The `seal` from `tasks`"),
  state: z.enum(["working", "waiting-eric", "done", "dropped"]),
  steps: z.array(Step).max(30).optional().describe("The full list every time"),
  task: z.string().optional().describe("The task's id"),
  title: z.string().trim().min(1).max(200).optional().describe("The part"),
});

type Step = z.infer<typeof Step>;
export type Update = z.infer<typeof Update>;
export type TaskState = Update["state"] | "open";
