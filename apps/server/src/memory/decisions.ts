import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { clock, DAY, HOUR, MIN } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { isoDateTime } from "../records/fields";
import { isSendable, MessageDraft, oneLine, StoredDraft } from "./draft";
import { resolveDraft, sendDraft, sendLimitMs } from "./draft-send";
import { type MatterStepNow, matterOfSteps, openStepsOf } from "./matter-read";
import { readMatterBook } from "./matters";
import { MEMORY } from "./memory-files";
import { readPeople } from "./who";
import { dayNow } from "./zones";

// The decisions: a question an agent puts to him, as one card: a title and a question of one line each, the exact
// draft he approves when there is one, 2 to 4 options (the recommended one first), its context folded, a deadline.
// Append-only, one synchronous line each, outside the lock like a correction: `asked` (`requestDecision`), his
// `answered` (the first wins; his own words alone are his "something else"), the asker's `withdrawn`, and, when his
// answer was a draft's outgoing option alone, the send's outcome (`sent` or `send-failed`, `draft-send.ts`), and when it
// was an `ends` option alone, the end's outcome (`ended`: his word that the step or matter is done, `endByHisWord`). A send
// that ended `not sent:` (nothing went) voids its answer: the card is open again and his next answer is the next first
// (his yes of 18 Nov 2026); `may have gone:` stays answered. Where each
// stands is worked out when read (`decisionsNow`); the open ones are checks (`checks.ts`), so he sees them in the one
// list. The file also holds earlier versions' lines: the old decisions page's (schemaVersion 1, before 2 Nov 2026) and
// the cards before titles (schemaVersion 2, none in his data on 18 Nov 2026): kept, never read.

export const DECISIONS = join(MEMORY, "decisions.jsonl");

const PROJECT_OR_AREA = /^(?:project|area):/;
/** The version decision lines are written at; earlier lines (the old decisions page's, the cards before titles) are skipped. */
const VERSION = 3;
const DecisionId = z.string().regex(/^dec_[0-9a-f]{12}$/);
const Option = z
  .object({
    /** His pick of it alone is his word that the card's step (`step`: the subject, one of its matter's open steps) or its whole matter (`matter`) is done: Life closes it (`endByHisWord`). Never on an `outgoing` option, never taken on silence. */
    ends: z.enum(["step", "matter"]).optional(),
    id: z.string().min(1).max(40),
    label: oneLine(120),
    /** An act that leaves Life (it sends, pays, books, deletes or changes something others see): never taken on silence. */
    outgoing: z.literal(true).optional(),
  })
  .strict();
/** What an asker gives (`requestDecision`, the connector's `request_decision`): an `asked` line less what Life stamps. */
export const Ask = z
  .object({
    /** The registered agent that asked (the desk's `agt_…`), when one did: stamped by the desk, never by the connector. */
    agent: z
      .string()
      .regex(/^agt_[0-9a-f]+$/)
      .optional(),
    context: z.string().max(4000).default(""),
    deadline: isoDateTime,
    draft: MessageDraft.optional(),
    links: z.array(z.url()).default([]),
    onSilence: z.string().nullable().default(null),
    /** The recommended one first. */
    options: z.array(Option).min(2).max(4),
    question: oneLine(120),
    /** A matter's id or a step's (it rides on that matter: listed while the matter is open; an id is stored as its newest step), or `project:<id>` or `area:<id>`; none for a task with neither. */
    subject: z.string().min(1).optional(),
    title: oneLine(80),
  })
  .strict();
const Withdrawal = z
  .object({
    agent: Ask.shape.agent,
    why: z.string().min(1).max(300),
    withdraw: z.string().describe("A decision id you asked, to withdraw it"),
  })
  .strict();
/** What an agent gives `request_decision` (the connector's, the door's): an `Ask` less the desk's stamp, or a withdrawal; `requestDecision` checks the rest. */
export const DecisionRequest = Ask.omit({ agent: true })
  .partial()
  .extend({
    why: Withdrawal.shape.why.optional().describe("With `withdraw`: why"),
    withdraw: Withdrawal.shape.withdraw.optional(),
  });

/** The card's rules in words, for every tool that asks one (the connector's `request_decision`, the door's). */
export const CARD =
  "One card: `title` (what you are trying to do, one line, 80 characters), `question` (what he decides, one line, 120, ending in a ?), `draft` (the exact message to approve, shown to him in full: `channel` the source it goes through; `to` a chat key from `read_chats`, or a person with one 1:1 chat there (for mail, addresses); `text`, a `file` (an absolute path: he sees its name and size, and Life sends the bytes it reads when you ask), or a `reaction` (an emoji, which needs `onMessage` and nothing else); `onMessage` a message's id (`read_chats`, `read_new_events`; for mail, its id from `search` or `fetch`), replied to (or reacted to); `mentions` (`[{name, sender}]`: each `@name` in `text`, in its order, `sender` the sender id `read_chats` shows for that person in this chat); for mail only `from`, `subject`, `cc`; a feature the chat can't take is refused when you ask; Life sends it exactly as shown when he picks its one `outgoing` option alone (with his words added, or another option, nothing is sent), and `decision.answered` carries `send`, the sent message's id or its error; a failed send is never retried: ask a new card), `options` (2 to 4 `{id, label}`, a label at most five words, the recommended one first, `outgoing: true` on one that acts outside Life (sends, pays, books, deletes or changes something others see), `ends: \"step\"` (`subject` one of its matter's open steps) or `ends: \"matter\"` on the one that means it is done (his pick of it alone closes that step, or every open step of the matter, in Life; never with `outgoing`, never `onSilence`, and `decision.answered` carries `end`, its error if it failed)), `context` (why, what was tried, what it rests on, with links: folded, about 10 lines), `links` (yours first), `deadline` (1 hour to 14 days ahead), `onSilence` (the option you take if he doesn't answer, never an outgoing or `ends` one, or null), `subject` (a matter's id or one of its steps': it leaves his list when the matter ends; or `project:<id>`, `area:<id>`). He can always answer in his own words instead (the answer's `note`).";

const Asked = Ask.extend({
  asker: z.string().min(1),
  at: isoDateTime,
  /** The draft as Life stored it when asked (`resolveDraft`): `to` the chat's name, `chat` and the stamps; a card asked before Life could send has none, and sends nothing. */
  draft: StoredDraft.optional(),
  id: DecisionId,
  kind: z.literal("asked"),
  schemaVersion: z.literal(VERSION),
}).strict();
const Answered = z
  .object({
    /** One tap's key, made by his app and kept on every repeat of that tap: a repeat finds this line and sends nothing. Lines before it have none. */
    answerKey: z.string().min(1).max(100).optional(),
    at: isoDateTime,
    id: DecisionId,
    kind: z.literal("answered"),
    note: z.string().min(1).optional(),
    /** The option ids he picked; none when he answered in words. */
    options: z.array(z.string()),
    schemaVersion: z.literal(VERSION),
    /** His app through the connector, or a session's `bun life` command, which never sends. */
    via: z.enum(["connector", "session"]),
  })
  .strict();
const Withdrawn = z
  .object({
    at: isoDateTime,
    id: DecisionId,
    kind: z.literal("withdrawn"),
    schemaVersion: z.literal(VERSION),
    why: z.string().min(1),
  })
  .strict();
/** What his answer sent: the sent message's id (Life's own event id where it knows it) once its network took it. */
const Sent = z
  .object({
    at: isoDateTime,
    eventId: z.string().min(1),
    id: DecisionId,
    kind: z.literal("sent"),
    schemaVersion: z.literal(VERSION),
  })
  .strict();
const SendFailed = Sent.omit({ eventId: true, kind: true })
  .extend({
    /** False when the same draft can never go (the file is gone or changed, no chat, the channel is off): his next tap would fail alike. */
    canRetry: z.literal(false).optional(),
    error: z.string().min(1),
    kind: z.literal("send-failed"),
    /** The message that refused the send ("someone wrote since"): when, by whom, its words on one line. */
    wrote: z
      .object({ at: isoDateTime, by: z.string(), text: z.string() })
      .strict()
      .optional(),
  })
  .strict();
/** What his answer's `ends` option closed (`endByHisWord`): `error` when it failed, or never finished. */
const Ended = z
  .object({
    at: isoDateTime,
    error: z.string().min(1).optional(),
    id: DecisionId,
    kind: z.literal("ended"),
    schemaVersion: z.literal(VERSION),
  })
  .strict();
const Line = z.discriminatedUnion("kind", [
  Asked,
  Answered,
  Withdrawn,
  Sent,
  SendFailed,
  Ended,
]);
/** A line of an earlier version: skipped. */
const Historical = z.object({ schemaVersion: z.literal([1, 2]) }).loose();
const Stored = z.union([Line, Historical]);

type Asked = z.infer<typeof Asked>;
type Answered = z.infer<typeof Answered>;
type Withdrawn = z.infer<typeof Withdrawn>;
type SendFailed = z.infer<typeof SendFailed>;
type Send = z.infer<typeof Sent> | SendFailed;
type Ended = z.infer<typeof Ended>;

type DecisionState = "answered" | "lapsed" | "open" | "withdrawn";
export type Decision = Asked & {
  answer?: Answered;
  end?: Ended;
  /** The newest `not sent:` outcome, which voided the answer in `voided` (the card is open again). */
  notSent?: SendFailed;
  send?: Send;
  state: DecisionState;
  /** Every answer a `not sent:` outcome voided, with that outcome, oldest first: a repeat of any of those taps (its `answerKey`) finds its own here. */
  voided?: { answer: Answered; notSent: SendFailed }[];
  withdrawn?: Withdrawn;
};

/** `d` with its answer voided by the `not sent:` outcome `l`: the card is open again, the answer kept in `voided`. */
const voidedBy = (d: Omit<Decision, "state">, l: SendFailed) => ({
  ...d,
  answer: undefined,
  notSent: l,
  send: undefined,
  voided: [
    ...(d.voided ?? []),
    ...(d.answer ? [{ answer: d.answer, notSent: l }] : []),
  ],
});

/** Every decision as stored, by id, in the order asked: the first answer kept, until a `not sent:` outcome voids it. */
const readAll = () =>
  readAppended(
    DECISIONS,
    Stored,
    (last?: Map<string, Omit<Decision, "state">>) => new Map(last),
    (all, l) => {
      if (l.schemaVersion !== VERSION) {
        return;
      }
      const d = all.get(l.id);
      if (l.kind === "asked") {
        all.set(l.id, l);
      } else if (d && l.kind === "answered" && !d.answer) {
        all.set(l.id, { ...d, answer: l });
      } else if (d && l.kind === "withdrawn" && !d.withdrawn) {
        all.set(l.id, { ...d, withdrawn: l });
      } else if (
        d &&
        l.kind === "send-failed" &&
        l.error.startsWith("not sent:")
      ) {
        all.set(l.id, voidedBy(d, l));
      } else if (d && (l.kind === "sent" || l.kind === "send-failed")) {
        all.set(l.id, { ...d, send: l });
      } else if (d && l.kind === "ended" && !d.end) {
        all.set(l.id, { ...d, end: l });
      }
    }
  );

const stateOf = (d: Omit<Decision, "state">, now: Date): DecisionState => {
  if (d.answer) {
    return "answered";
  }
  if (d.withdrawn) {
    return "withdrawn";
  }
  return Date.parse(d.deadline) <= now.getTime() ? "lapsed" : "open";
};

type Act = "end" | "send";

/** What an option does when he picks it alone with no words: `send` the card's draft (its `outgoing` option), `end` its step or matter (`ends`), else nothing. */
const actOfOption = (
  d: Pick<Decision, "draft">,
  o?: z.infer<typeof Option>
) => {
  if (o?.outgoing && isSendable(d.draft)) {
    return "send";
  }
  return o?.ends ? "end" : undefined;
};

/** What an answer does besides being recorded: its one option picked alone, with no words of his changing it (`actOfOption`). */
export const actOf = (
  d: Pick<Decision, "draft" | "options">,
  options: string[],
  note?: string
): Act | undefined =>
  note || options.length !== 1
    ? undefined
    : actOfOption(
        d,
        d.options.find((o) => o.id === options[0])
      );

/** What his answer is due to do (`actOf`), if anything. */
export const actDueOf = (d: Omit<Decision, "state">) =>
  d.answer ? actOf(d, d.answer.options, d.answer.note) : undefined;

/** The outcome of his answer's act, as stored: the send's, or the end's. */
export const actOutcomeOf = (d: Pick<Decision, "end" | "send">, act: Act) =>
  act === "send" ? d.send : d.end;

/** An act with no outcome this long past its own limit never ended (a crash): the reads before it and the line's write. */
const ACT_GRACE = MIN;
/** The most an end may take: a tick per to-do item, a minute each (`TICK_LIMIT_MS`, host).
 * ponytail: fixed; a matter of more than 29 open to-do items may read as never ended while it still ticks. */
const END_LIMIT_MS = 30 * MIN;

/** `d` with its act's outcome as stored, or, past its limit (a send's path's own, `sendLimitMs`) and `ACT_GRACE` with none, one that never ended. */
function withOutcomeOf(
  d: Omit<Decision, "state">,
  now: Date
): Omit<Decision, "state"> {
  const act = actDueOf(d);
  if (!(act && d.answer) || actOutcomeOf(d, act)) {
    return d;
  }
  const limit = act === "send" && d.draft ? sendLimitMs(d.draft) : END_LIMIT_MS;
  const end = Date.parse(d.answer.at) + limit + ACT_GRACE;
  if (now.getTime() < end) {
    return d;
  }
  const line: Pick<Ended, "at" | "id" | "schemaVersion"> = {
    at: new Date(end).toISOString(),
    id: d.id,
    schemaVersion: VERSION,
  };
  return act === "send"
    ? {
        ...d,
        send: {
          ...line,
          error:
            "may have gone: a send started and never ended: read the chat before asking again",
          kind: "send-failed",
        },
      }
    : {
        ...d,
        end: {
          ...line,
          error:
            "may not have ended: it started and never finished: read the matter before asking again",
          kind: "ended",
        },
      };
}

/** Closes the step or matter of the decision `d` by his word (host: `endByHisWord`); throws when it could not. */
export type EndByHisWord = (d: Omit<Decision, "state">) => Promise<unknown>;

/** Every decision with where it stands at `now`: open, answered, lapsed (its deadline passed) or withdrawn. */
export const decisionsNow = (now = clock()): Decision[] =>
  [...readAll().values()].map((d) => ({
    ...withOutcomeOf(d, now),
    state: stateOf(d, now),
  }));

/** Registered agent `agent`'s open decision, if any: it asks one at a time (`requestDecision`), worked out from `list`, never stored. */
export const openDecisionOf = (agent: string, list = decisionsNow()) =>
  list.find((d) => d.agent === agent && d.state === "open");

function readOpenDecision(id: string, now: Date) {
  const d = decisionsNow(now).find((x) => x.id === id);
  if (!d) {
    throw new Error(`Not done: no decision ${id}.`);
  }
  if (d.state !== "open") {
    throw new Error(
      `Not done: ${id} is ${d.state}${d.answer ? ` (${d.answer.at})` : ""}.`
    );
  }
  return d;
}

/** Whether a decision's subject is a matter step (else a project, an area or none). */
export const isOnMatter = (subject?: string): subject is string =>
  subject !== undefined && !PROJECT_OR_AREA.test(subject);

/** Withdraws the open decision `request.withdraw`, only by the asker that asked it. */
function withdrawDecision(
  asker: string,
  request: Partial<z.input<typeof Withdrawal>>,
  now: Date
) {
  const w = Withdrawal.safeParse(request);
  if (!w.success) {
    throw new Error(`Not done: ${z.prettifyError(w.error)}`);
  }
  const d = readOpenDecision(w.data.withdraw, now);
  // Every registered agent asks as `desk`: its own `agent` tells them apart.
  if (d.asker !== asker || d.agent !== w.data.agent) {
    throw new Error(`Not done: ${d.id} was asked by another agent.`);
  }
  appendJsonl(DECISIONS, Withdrawn, [
    {
      at: now.toISOString(),
      id: d.id,
      kind: "withdrawn",
      schemaVersion: VERSION,
      why: w.data.why,
    },
  ]);
  return { id: d.id };
}

const WHITESPACE = /\s+/;

/** What breaks the card's rules beyond its shape, in words the agent can fix; false when nothing does. */
function cardProblemOf(ask: z.infer<typeof Ask>, now: Date) {
  const ids = ask.options.map((o) => o.id);
  const ahead = Date.parse(ask.deadline) - now.getTime();
  const silence = ask.options.find((o) => o.id === ask.onSilence);
  return (
    (new Set(ids).size !== ids.length && "option ids repeat") ||
    (ask.onSilence !== null &&
      !silence &&
      "`onSilence` must be an option id") ||
    (silence?.outgoing &&
      "`onSilence` never takes an `outgoing` option: on silence nothing goes out") ||
    (ask.draft &&
      ask.options.filter((o) => o.outgoing).length !== 1 &&
      "a `draft` needs the one option that sends it marked `outgoing`") ||
    (!ask.question.trim().endsWith("?") && "`question` must end in a ?") ||
    (ask.options.find((o) => o.label.trim().split(WHITESPACE).length > 5) &&
      "an option's `label` is at most five words") ||
    ((ahead < HOUR || ahead > 14 * DAY) &&
      "the deadline must be 1 hour to 14 days ahead")
  );
}

/**
 * What breaks the rules of an `ends` option, in words the agent can fix; false when nothing does. `matter`: the open
 * matter the subject is or rides on. A step's card closes its subject, which must be one of the matter's open steps
 * (`openStepsOf`); a matter's needs one open (nothing else closes a matter by his word).
 */
function endsProblemOf(
  ask: z.infer<typeof Ask>,
  matter?: { id: string; steps: readonly MatterStepNow[] }
) {
  const ends = ask.options.filter((o) => o.ends);
  if (ends.length === 0) {
    return false;
  }
  return (
    (ends.some((o) => o.outgoing) &&
      "an option acts outside Life (`outgoing`) or closes in Life (`ends`), never both") ||
    (ends.some((o) => o.id === ask.onSilence) &&
      "`onSilence` never takes an `ends` option: only his pick closes anything") ||
    (!matter &&
      "`ends` needs a `subject` on an open matter (its id or a step's)") ||
    (ends.some((o) => o.ends === "step") &&
      (matter?.id === ask.subject ||
        openStepsOf(matter ?? { steps: [] }, ask.subject).length === 0) &&
      "`ends: \"step\"` needs `subject` to be one of the matter's open steps (a to-do, promise, wait or to-do item), not the matter's id") ||
    (openStepsOf(matter ?? { steps: [] }).length === 0 &&
      '`ends: "matter"` needs an open to-do, promise, wait or to-do item on the matter')
  );
}

/**
 * Records a decision `asker` (an agent's pairing, or `desk`) asks, or its withdrawal by that same asker. A draft's chat
 * is resolved now (`readChat`), so his card names it and nothing is sent to a chat he didn't see.
 */
export async function requestDecision(
  asker: string,
  // Partial: an agent's arguments arrive unchecked; `Ask` checks them here.
  request: Partial<z.input<typeof Ask>> | Partial<z.input<typeof Withdrawal>>,
  now = clock(),
  readChat = resolveDraft
): Promise<{ id: string }> {
  if ("withdraw" in request && request.withdraw) {
    return withdrawDecision(asker, request, now);
  }
  const parsed = Ask.safeParse(request);
  if (!parsed.success) {
    throw new Error(`Not done: ${z.prettifyError(parsed.error)}`);
  }
  const ask = parsed.data;
  const problem = cardProblemOf(ask, now);
  if (problem) {
    throw new Error(`Not done: ${problem}.`);
  }
  // A registered agent asks him one thing at a time (an inbox rule, not a limit on its work).
  const open = ask.agent
    ? openDecisionOf(ask.agent, decisionsNow(now))
    : undefined;
  if (open) {
    throw new Error(
      `Not done: ${ask.agent} already asks ${open.id}; withdraw it or wait for his answer.`
    );
  }
  // A step no open matter holds would never be listed: refused, so no question goes unseen. A matter's own id rides on
  // its newest step: a step outlives a re-group, a matter id doesn't.
  const matter = isOnMatter(ask.subject)
    ? matterOfSteps(
        (await readMatterBook(await readPeople(), dayNow())).filter(
          (m) => m.open
        ),
        [ask.subject]
      )
    : undefined;
  if (isOnMatter(ask.subject) && !matter) {
    throw new Error(
      `Not done: no open matter is or holds ${ask.subject}; give its id or a step's, \`project:<id>\`, \`area:<id>\` or no subject.`
    );
  }
  const endsProblem = endsProblemOf(ask, matter);
  if (endsProblem) {
    throw new Error(`Not done: ${endsProblem}.`);
  }
  // An `ends` card on a matter's id rides on its newest open step (`endsProblemOf` checked one is there): its newest
  // step may be closed, or a unit other matters share, and closing would then find another matter.
  const newest = ask.options.some((o) => o.ends)
    ? matter && openStepsOf(matter).at(-1)
    : matter?.steps.at(-1);
  const subject =
    matter && matter.id === ask.subject ? newest?.ref : ask.subject;
  const draft = ask.draft && (await readChat(ask.draft, now));
  const id = `dec_${randomBytes(6).toString("hex")}`;
  appendJsonl(DECISIONS, Asked, [
    {
      ...ask,
      ...(draft ? { draft } : {}),
      ...(subject ? { subject } : {}),
      asker,
      at: now.toISOString(),
      // In UTC, so deadlines sort as strings (`checksOf`).
      deadline: new Date(ask.deadline).toISOString(),
      id,
      kind: "asked",
      schemaVersion: VERSION,
    },
  ]);
  return { id };
}

/** What makes an answer to `d` refused, in words; false when nothing does. An act (`actOfOption`) is his own app's alone: a send `via` the connector, an end only where host gives `end` (`canEnd`). */
function answerProblemOf(
  d: Omit<Decision, "state">,
  options: string[],
  note: string | undefined,
  { canEnd, via }: { canEnd: boolean; via: Answered["via"] }
) {
  const unknown = options.filter((o) => !d.options.some((x) => x.id === o));
  const acts = d.options
    .filter((o) => options.includes(o.id))
    .map((o) => actOfOption(d, o));
  return (
    (unknown.length > 0 &&
      `${unknown.join(", ")} not among ${d.id}'s options.`) ||
    (options.length === 0 &&
      !note &&
      "pick an option or give his words as `note`.") ||
    (acts.includes("send") &&
      via !== "connector" &&
      "a draft is sent only on his own answer, through `answer_check` in his app.") ||
    (acts.includes("end") &&
      !canEnd &&
      "a step is closed only on his own answer, through `answer_check` in his app.")
  );
}

/** Closes the step or matter of the answered decision `d` by his word (`end`) and appends its `ended` line, with the error when it failed. */
async function endOnAnswer(
  d: Omit<Decision, "state">,
  end: EndByHisWord,
  onStep?: (step: string, detail?: Record<string, unknown>) => void
) {
  const outcome = await end(d).then(
    () => ({}),
    (e: Error) => ({ error: e.message })
  );
  const ended: Ended = {
    at: clock().toISOString(),
    id: d.id,
    kind: "ended",
    schemaVersion: VERSION,
    ...outcome,
  };
  appendJsonl(DECISIONS, Ended, [ended]);
  onStep?.("ended", ended.error ? { error: ended.error } : undefined);
  return ended;
}

/**
 * Records his answer to an open decision: option ids, or none with his words. The first answer stands; a second is
 * refused, unless its send ended `not sent:` (then the card is open and the next answer is the first). When it is a
 * draft's outgoing option alone, through his app (`via` connector), Life sends the draft once (`deliver`) and records
 * the outcome: the answer is written first, so a repeated or concurrent answer never sends again. When it is an `ends`
 * option alone, `end` (host's `endByHisWord`, given only for his own token's `answer_check`) closes its step or matter
 * once, and the `ended` line records it. `onStep` hears `recorded` and then the act's own steps (an end's: `ended`).
 */
export async function answerDecision(
  id: string,
  options: string[],
  note?: string,
  {
    answerKey,
    deliver = sendDraft,
    end,
    now = clock(),
    onStep,
    via = "session",
  }: {
    answerKey?: string;
    deliver?: typeof sendDraft;
    end?: EndByHisWord;
    now?: Date;
    onStep?: (step: string, detail?: Record<string, unknown>) => void;
    via?: Answered["via"];
  } = {}
) {
  const d = readOpenDecision(id, now);
  const problem = answerProblemOf(d, options, note, {
    canEnd: Boolean(end),
    via,
  });
  if (problem) {
    throw new Error(`Not done: ${problem}`);
  }
  const line: Answered = {
    at: now.toISOString(),
    ...(answerKey ? { answerKey } : {}),
    id,
    kind: "answered",
    ...(note ? { note } : {}),
    options,
    schemaVersion: VERSION,
    via,
  };
  appendJsonl(DECISIONS, Answered, [line]);
  const stored = readAll().get(id);
  if (!(stored && isDeepStrictEqual(stored.answer, line))) {
    throw new Error(`Not done: ${id} was answered already.`);
  }
  onStep?.("recorded");
  const act = actDueOf(stored);
  if (act === "end" && end) {
    return [line, await endOnAnswer(stored, end, onStep)];
  }
  if (!(act === "send" && isSendable(stored.draft))) {
    return [line];
  }
  // "Someone wrote since" counts from his last attempt that went nowhere, else from the card.
  const since = new Date(stored.notSent?.at ?? stored.at);
  const outcome = await deliver(stored.draft, id, { onStep, since }).then(
    (eventId) => ({ eventId, kind: "sent" as const }),
    (e: Error & { canRetry?: false; wrote?: SendFailed["wrote"] }) => ({
      error: e.message,
      kind: "send-failed" as const,
      ...(e.canRetry === false ? { canRetry: false as const } : {}),
      ...(e.wrote ? { wrote: e.wrote } : {}),
    })
  );
  const sent = {
    at: clock().toISOString(),
    id,
    schemaVersion: VERSION,
    ...outcome,
  };
  appendJsonl(DECISIONS, z.union([Sent, SendFailed]), [sent]);
  return [line, sent];
}

/** What his last answer's failed send left, for the app: when, why, and whether another tap could work (not when the card's deadline passed before it ended); null when nothing is left. */
export const notSentOf = (d: Decision, n = d.notSent) =>
  n
    ? {
        at: n.at,
        canRetry: n.canRetry !== false && n.at < d.deadline,
        reason: n.error,
        wrote: n.wrote ?? null,
      }
    : null;

/**
 * When a decision settled, as its asker hears it: its act's outcome when his answer sent its draft or ended its step
 * (none while the act runs), else his answer's instant, or the deadline for a lapse.
 */
export const settledAtOf = (d: Decision) => {
  const act = actDueOf(d);
  return act
    ? actOutcomeOf(d, act)?.at
    : (d.answer?.at ??
        // A lapse whose answer a `not sent:` voided after the deadline settles then, so a poll past the deadline still sees it.
        (d.notSent && d.notSent.at > d.deadline ? d.notSent.at : d.deadline));
};

/**
 * The decisions answered or lapsed in [`from`, `to`), by when they settled (`settledAtOf`; a withdrawal is the asker's
 * own act). Half-open, so a poll's next window starts at this one's end and none is seen twice or skipped.
 */
export const settledBetween = (list: Decision[], from: Date, to: Date) =>
  list
    .map((d) => ({ at: Date.parse(settledAtOf(d) ?? ""), d }))
    .filter(
      ({ at, d }) =>
        (d.state === "answered" || d.state === "lapsed") &&
        at >= from.getTime() &&
        at < to.getTime()
    )
    .toSorted((a, b) => a.at - b.at)
    .map((x) => x.d);
