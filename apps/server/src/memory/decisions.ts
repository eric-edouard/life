import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { clock, DAY, HOUR, MIN } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { isoDateTime } from "../records/fields";
import { isSendable, MessageDraft, oneLine, StoredDraft } from "./draft";
import { resolveDraft, sendDraft } from "./draft-send";
import { readMatterBook } from "./matters";
import { MEMORY } from "./memory-files";
import { readPeople } from "./who";
import { dayNow } from "./zones";

// The decisions: a question an agent puts to him, as one card: a title and a question of one line each, the exact
// draft he approves when there is one, 2 to 4 options (the recommended one first), its context folded, a deadline.
// Append-only, one synchronous line each, outside the lock like a correction: `asked` (`requestDecision`), his
// `answered` (the first wins; his own words alone are his "something else"), the asker's `withdrawn`, and, when his
// answer was a draft's outgoing option alone, the send's outcome (`sent` or `send-failed`, `draft-send.ts`). A send
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
    id: z.string().min(1).max(40),
    label: oneLine(120),
    /** It sends, pays, books, deletes or changes something: never taken on silence. */
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
    /** A matter step's id (it rides on that matter: listed while the matter is open), or `project:<id>` or `area:<id>`; none for a task with neither. */
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
  "One card: `title` (what you are trying to do, one line, 80 characters), `question` (what he decides, one line, 120), `draft` (the exact message to approve, shown to him in full: `channel` the source it goes through; `to` a chat key from `read_chats`, or a person with one 1:1 chat there (for mail, addresses); `text`, a `file` (an absolute path: he sees its name and size, and Life sends the bytes it reads when you ask), or a `reaction` (an emoji, which needs `onMessage` and nothing else); `onMessage` a message's id (`read_chats`, `read_new_events`; for mail, its id from `search` or `fetch`), replied to (or reacted to); `mentions` (`[{name, sender}]`: each `@name` in `text`, in its order, `sender` the sender id `read_chats` shows for that person in this chat); for mail only `from`, `subject`, `cc`; a feature the chat can't take is refused when you ask; Life sends it exactly as shown when he picks its one `outgoing` option alone (with his words added, or another option, nothing is sent), and `decision.answered` carries `send`, the sent message's id or its error; a failed send is never retried: ask a new card), `options` (2 to 4 `{id, label}`, one line each, the recommended one first, `outgoing: true` on one that sends, pays, books, deletes or changes something), `context` (why, what was tried, what it rests on, with links: folded, about 10 lines), `links` (yours first), `deadline` (1 hour to 14 days ahead), `onSilence` (the option you take if he doesn't answer, never an outgoing one, or null), `subject` (a matter step's id: it leaves his list when the matter ends; or `project:<id>`, `area:<id>`). He can always answer in his own words instead (the answer's `note`).";

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
    error: z.string().min(1),
    kind: z.literal("send-failed"),
    /** False when the same draft can never go (the file is gone or changed, no chat, the channel is off): his next tap would fail alike. */
    retry: z.literal(false).optional(),
  })
  .strict();
const Line = z.discriminatedUnion("kind", [
  Asked,
  Answered,
  Withdrawn,
  Sent,
  SendFailed,
]);
/** A line of an earlier version: skipped. */
const Historical = z.object({ schemaVersion: z.literal([1, 2]) }).loose();
const Stored = z.union([Line, Historical]);

type Asked = z.infer<typeof Asked>;
type Answered = z.infer<typeof Answered>;
type Withdrawn = z.infer<typeof Withdrawn>;
type SendFailed = z.infer<typeof SendFailed>;
type Send = z.infer<typeof Sent> | SendFailed;

type DecisionState = "answered" | "lapsed" | "open" | "withdrawn";
export type Decision = Asked & {
  answer?: Answered;
  /** The newest `not sent:` outcome, which voided the answer in `voided` (the card is open again). */
  notSent?: SendFailed;
  send?: Send;
  state: DecisionState;
  /** The answer a `not sent:` outcome voided: a repeat of its tap finds it here. */
  voided?: Answered;
  withdrawn?: Withdrawn;
};

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
        all.set(l.id, {
          ...d,
          answer: undefined,
          notSent: l,
          send: undefined,
          voided: d.answer,
        });
      } else if (d && (l.kind === "sent" || l.kind === "send-failed")) {
        all.set(l.id, { ...d, send: l });
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

/** Whether an answer sends the card's draft: its one outgoing option picked alone, with no words of his changing it. */
export const sendsOn = (
  d: Omit<Decision, "state">,
  options: string[],
  note?: string
) =>
  Boolean(
    isSendable(d.draft) &&
      !note &&
      options.length === 1 &&
      d.options.find((o) => o.id === options[0])?.outgoing
  );

/** Whether his answer sends the card's draft (`sendsOn`). */
export const isSendDue = (d: Omit<Decision, "state">) =>
  Boolean(d.answer && sendsOn(d, d.answer.options, d.answer.note));

/** A send with no outcome this long after his answer never ended (a crash): a send path ends within about 3 minutes, a file's upload and confirmation included (`matrixSend`). */
export const SEND_ENDS_AFTER = 5 * MIN;

/** The send's outcome as stored, or, past `SEND_ENDS_AFTER` with none, one that never ended. */
function sendOf(d: Omit<Decision, "state">, now: Date): Send | undefined {
  const due = d.answer && isSendDue(d) ? Date.parse(d.answer.at) : undefined;
  if (d.send || due === undefined || now.getTime() < due + SEND_ENDS_AFTER) {
    return d.send;
  }
  return {
    at: new Date(due + SEND_ENDS_AFTER).toISOString(),
    error:
      "may have gone: a send started and never ended: read the chat before asking again",
    id: d.id,
    kind: "send-failed",
    schemaVersion: VERSION,
  };
}

/** Every decision with where it stands at `now`: open, answered, lapsed (its deadline passed) or withdrawn. */
export const decisionsNow = (now = clock()): Decision[] =>
  [...readAll().values()].map((d) => ({
    ...d,
    send: sendOf(d, now),
    state: stateOf(d, now),
  }));

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
    ((ahead < HOUR || ahead > 14 * DAY) &&
      "the deadline must be 1 hour to 14 days ahead")
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
    ? decisionsNow(now).find((d) => d.agent === ask.agent && d.state === "open")
    : undefined;
  if (open) {
    throw new Error(
      `Not done: ${ask.agent} already asks ${open.id}; withdraw it or wait for his answer.`
    );
  }
  // A step no open matter holds would never be listed: refused, so no question goes unseen.
  if (
    isOnMatter(ask.subject) &&
    !(await readMatterBook(await readPeople(), dayNow())).some(
      (m) => m.open && m.steps.some((x) => x.ref === ask.subject)
    )
  ) {
    throw new Error(
      `Not done: no open matter holds ${ask.subject}; give its step id, \`project:<id>\`, \`area:<id>\` or no subject.`
    );
  }
  const draft = ask.draft && (await readChat(ask.draft, now));
  const id = `dec_${randomBytes(6).toString("hex")}`;
  appendJsonl(DECISIONS, Asked, [
    {
      ...ask,
      ...(draft ? { draft } : {}),
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

/**
 * Records his answer to an open decision: option ids, or none with his words. The first answer stands; a second is
 * refused, unless its send ended `not sent:` (then the card is open and the next answer is the first). When it is a
 * draft's outgoing option alone, through his app (`via` connector), Life sends the draft once (`deliver`) and records
 * the outcome: the answer is written first, so a repeated or concurrent answer never sends again. `onStep` hears
 * `recorded` and then the send's own steps.
 */
export async function answerDecision(
  id: string,
  options: string[],
  note?: string,
  {
    answerKey,
    deliver = sendDraft,
    now = clock(),
    onStep,
    via = "session",
  }: {
    answerKey?: string;
    deliver?: typeof sendDraft;
    now?: Date;
    onStep?: (step: string, detail?: Record<string, unknown>) => void;
    via?: Answered["via"];
  } = {}
) {
  const d = readOpenDecision(id, now);
  const unknown = options.filter((o) => !d.options.some((x) => x.id === o));
  if (unknown.length > 0 || (options.length === 0 && !note)) {
    throw new Error(
      unknown.length > 0
        ? `Not done: ${unknown.join(", ")} not among ${id}'s options.`
        : "Not done: pick an option or give his words as `note`."
    );
  }
  if (
    via !== "connector" &&
    isSendable(d.draft) &&
    d.options.some((o) => o.outgoing && options.includes(o.id))
  ) {
    throw new Error(
      "Not done: a draft is sent only on his own answer, through `answer_check` in his app."
    );
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
  if (!(isSendDue(stored) && isSendable(stored.draft))) {
    return [line];
  }
  // "Someone wrote since" counts from his last attempt that went nowhere, else from the card.
  const since = new Date(stored.notSent?.at ?? stored.at);
  const outcome = await deliver(stored.draft, id, { onStep, since }).then(
    (eventId) => ({ eventId, kind: "sent" as const }),
    (e: Error & { retry?: false }) => ({
      error: e.message,
      kind: "send-failed" as const,
      ...(e.retry === false ? { retry: false as const } : {}),
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

/**
 * When a decision settled, as its asker hears it: the send's outcome when his answer sent its draft (none while the
 * send runs), else his answer's instant, or the deadline for a lapse.
 */
export const settledAtOf = (d: Decision) =>
  d.answer && isSendDue(d)
    ? d.send?.at
    : (d.answer?.at ??
      // A lapse whose answer a `not sent:` voided after the deadline settles then, so a poll past the deadline still sees it.
      (d.notSent && d.notSent.at > d.deadline ? d.notSent.at : d.deadline));

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

/** When a decision is pushed: as its deadline comes within 24 hours, or when asked if it already has. */
const pushAtOf = (d: Decision) =>
  Math.max(Date.parse(d.at), Date.parse(d.deadline) - DAY);

/** The open decisions whose push instant falls in (`since`, `now`]: each is due once. */
export const pushDueOf = (list: Decision[], since: Date, now: Date) =>
  list.filter(
    (d) =>
      d.state === "open" &&
      pushAtOf(d) > since.getTime() &&
      pushAtOf(d) <= now.getTime()
  );
