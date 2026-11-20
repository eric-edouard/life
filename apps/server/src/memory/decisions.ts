import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { clock, MIN } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { payments } from "../payments/backend";
import { isoDateTime } from "../records/fields";
import {
  cardProblemOf,
  endsProblemOf,
  notBuiltOf,
  pageHintOf,
} from "./card-problems";
import { Ask, type Option, Withdrawal } from "./card-request";
import { isSendable, StoredDraft } from "./draft";
import { resolveDraft, sendDraft, sendLimitMs, wroteSince } from "./draft-send";
import { matterOfSteps, openStepsOf } from "./matter-read";
import { readMatterBook } from "./matters";
import { MEMORY } from "./memory-files";
import { amountOf, needsShownOf, payeeWordsOf } from "./needs";
import { readPeople } from "./who";
import { dayNow } from "./zones";

// The decisions: a question an agent puts to him, as one card: a title and a question of one line each, the exact
// draft he approves when there is one, 2 to 4 options (the recommended one first), its context folded, a deadline.
// Append-only, one synchronous line each, outside the lock like a correction: `asked` (`requestDecision`), his
// `answered` (the first wins; his own words alone are his "something else"), the asker's `withdrawn` (or Life's, when he
// answered in a draft's chat himself: `withdrawDraftsAnsweredInChat`), and, when his
// answer was a draft's outgoing option alone, the send's outcome (`sent` or `send-failed`, `draft-send.ts`), and when it
// was an `ends` option alone, the end's outcome (`ended`: his word that the step or matter is done, `endByHisWord`). A send
// that ended `not sent:` (nothing went) voids its answer: the card is open again and his next answer is the next first
// (his yes of 18 Nov 2026); `may have gone:` stays answered. A card Life sees done itself (`doneSeenBy`: a payment) gets
// Life's outcome line `done-seen` (`recordDoneSeen`), never his answer: on his pick of its `looks` option alone, `seen` or
// `not_found` (which voids the answer as `not sent:` does), and from the watcher's look while it is open, `seen` alone,
// which settles the card with no answer of his (`seen`). Where each
// stands is worked out when read (`decisionsNow`); the open ones are checks (`checks.ts`), so he sees them in the one
// list. The file also holds earlier versions' lines: the old decisions page's (schemaVersion 1, before 2 Nov 2026) and
// the cards before titles (schemaVersion 2, none in his data on 18 Nov 2026): kept, never read.

export const DECISIONS = join(MEMORY, "decisions.jsonl");

const PROJECT_OR_AREA = /^(?:project|area):/;
/** The version decision lines are written at; earlier lines (the old decisions page's, the cards before titles) are skipped. */
const VERSION = 3;
const DecisionId = z.string().regex(/^dec_[0-9a-f]{12}$/);
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
    /** When he wrote in the draft's chat himself, Life withdrew it (`withdrawDraftsAnsweredInChat`): his message's instant, never its words. The asker's own withdrawal has none. */
    answeredInChatAt: isoDateTime.optional(),
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
/** Life's outcome when it looked for the card's step done (`recordDoneSeen`): `seen` (the event, `eventId`), or `not_found` (with `error` when the look failed or never finished). Never his answer. */
const DoneSeen = z
  .object({
    at: isoDateTime,
    error: z.string().min(1).optional(),
    eventId: z.string().min(1).optional(),
    id: DecisionId,
    kind: z.literal("done-seen"),
    schemaVersion: z.literal(VERSION),
    state: z.enum(["seen", "not_found"]),
  })
  .strict();
const Line = z.discriminatedUnion("kind", [
  Asked,
  Answered,
  Withdrawn,
  Sent,
  SendFailed,
  Ended,
  DoneSeen,
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
type DoneSeen = z.infer<typeof DoneSeen>;

type DecisionState = "answered" | "lapsed" | "open" | "seen" | "withdrawn";
export type Decision = Asked & {
  answer?: Answered;
  /** Life's newest look: the one his answer's look made, a `seen` that settled the card, or a `not_found` that voided his answer (the card is open again). */
  doneSeen?: DoneSeen;
  end?: Ended;
  /** The newest `not sent:` outcome, which voided the answer in `voided` (the card is open again). */
  notSent?: SendFailed;
  send?: Send;
  state: DecisionState;
  /** Every answer a `not sent:` or `not_found` outcome voided, with that outcome, oldest first: a repeat of any of those taps (its `answerKey`) finds its own here. */
  voided?: { answer: Answered; doneSeen?: DoneSeen; notSent?: SendFailed }[];
  withdrawn?: Withdrawn;
};

/** `d` with its answer voided by the `not sent:` or `not_found` outcome `l`: the card is open again, the answer kept in `voided`. */
const voidedBy = (d: Omit<Decision, "state">, l: SendFailed | DoneSeen) => {
  const outcome = l.kind === "done-seen" ? { doneSeen: l } : { notSent: l };
  return {
    ...d,
    ...outcome,
    answer: undefined,
    send: undefined,
    voided: [
      ...(d.voided ?? []),
      ...(d.answer ? [{ answer: d.answer, ...outcome }] : []),
    ],
  };
};

/** `d` with Life's look `l` read: the first `seen` stands; a `not_found` is an answer's look's outcome only, and voids it; else unchanged. */
function withDoneSeen(d: Omit<Decision, "state">, l: DoneSeen) {
  if (l.state === "seen" && d.doneSeen?.state !== "seen") {
    return { ...d, doneSeen: l };
  }
  return l.state === "not_found" && d.answer && !d.doneSeen
    ? voidedBy(d, l)
    : d;
}

/** `d` with its line `l` read: the first answer, withdrawal and end stand; a `not sent:` outcome voids the answer. */
function withLine(
  d: Omit<Decision, "state">,
  l: Exclude<z.infer<typeof Line>, Asked>
): Omit<Decision, "state"> {
  switch (l.kind) {
    case "answered":
      // A `not_found` that voided an earlier answer is no outcome of this one.
      return d.answer
        ? d
        : {
            ...d,
            answer: l,
            doneSeen: d.doneSeen?.state === "seen" ? d.doneSeen : undefined,
          };
    case "done-seen":
      return withDoneSeen(d, l);
    case "withdrawn":
      return d.withdrawn ? d : { ...d, withdrawn: l };
    case "send-failed":
      return l.error.startsWith("not sent:")
        ? voidedBy(d, l)
        : { ...d, send: l };
    case "sent":
      return { ...d, send: l };
    default:
      return d.end ? d : { ...d, end: l };
  }
}

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
      } else if (d) {
        all.set(l.id, withLine(d, l));
      }
    }
  );

const stateOf = (d: Omit<Decision, "state">, now: Date): DecisionState => {
  if (d.answer) {
    return "answered";
  }
  if (d.doneSeen?.state === "seen") {
    return "seen";
  }
  if (d.withdrawn) {
    return "withdrawn";
  }
  return Date.parse(d.deadline) <= now.getTime() ? "lapsed" : "open";
};

type Act = "end" | "look" | "send";

/** How Life sees `d`'s step done now: `payment` while payments are on and it names an amount and a payee (amendment 1: a card with no channel to look in is `tap`), else `tap`. */
export const doneSeenByOf = (
  d: Pick<Decision, "doneSeenBy" | "needs">
): "payment" | "tap" =>
  d.doneSeenBy === "payment" &&
  payments() &&
  amountOf(d.needs) &&
  payeeWordsOf(d.needs).length > 0
    ? "payment"
    : "tap";

/** What an option does when he picks it alone with no words: `send` the card's draft (its `outgoing` option), `look` for its step done (`looks`, while Life can), `end` its step or matter (`ends`), else nothing. */
const actOfOption = (
  d: Pick<Decision, "doneSeenBy" | "draft" | "needs">,
  o?: z.infer<typeof Option>
) => {
  if (o?.outgoing && isSendable(d.draft)) {
    return "send";
  }
  if (o?.looks && doneSeenByOf(d) !== "tap") {
    return "look";
  }
  return o?.ends ? "end" : undefined;
};

/** What an answer does besides being recorded: its one option picked alone, with no words of his changing it (`actOfOption`). */
export const actOf = (
  d: Pick<Decision, "doneSeenBy" | "draft" | "needs" | "options">,
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

/** The outcome of his answer's act, as stored: the send's, the look's, or the end's. */
export const actOutcomeOf = (
  d: Pick<Decision, "doneSeen" | "end" | "send">,
  act: Act
) => ({ end: d.end, look: d.doneSeen, send: d.send })[act];

/** An act with no outcome this long past its own limit never ended (a crash): the reads before it and the line's write. */
const ACT_GRACE = MIN;
/** The most an end may take: a tick per to-do item, a minute each (`TICK_LIMIT_MS`, host).
 * ponytail: fixed; a matter of more than 29 open to-do items may read as never ended while it still ticks. */
const END_LIMIT_MS = 30 * MIN;
/** The most a look may take: one read of his accounts (host's payments read gives up at 20 s). */
export const LOOK_LIMIT_MS = 30_000;

/** `d` with its act's outcome as stored, or, past its limit (a send's path's own, `sendLimitMs`) and `ACT_GRACE` with none, one that never ended. */
function withOutcomeOf(
  d: Omit<Decision, "state">,
  now: Date
): Omit<Decision, "state"> {
  const act = actDueOf(d);
  if (!(act && d.answer) || actOutcomeOf(d, act)) {
    return d;
  }
  const limits = {
    end: END_LIMIT_MS,
    look: LOOK_LIMIT_MS,
    send: d.draft ? sendLimitMs(d.draft) : END_LIMIT_MS,
  };
  const end = Date.parse(d.answer.at) + limits[act] + ACT_GRACE;
  if (now.getTime() < end) {
    return d;
  }
  const line: Pick<Ended, "at" | "id" | "schemaVersion"> = {
    at: new Date(end).toISOString(),
    id: d.id,
    schemaVersion: VERSION,
  };
  // A look that never finished found nothing: the card is open again, as after any `not_found`.
  if (act === "look") {
    return voidedBy(d, {
      ...line,
      error: "the look never finished",
      kind: "done-seen",
      state: "not_found",
    });
  }
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

/** Every decision with where it stands at `now`: open, answered, seen (Life saw its step done, no answer of his), lapsed (its deadline passed) or withdrawn. */
export const decisionsNow = (now = clock()): Decision[] =>
  [...readAll().values()].map((d) => {
    const o = withOutcomeOf(d, now);
    return { ...o, state: stateOf(o, now) };
  });

/** Registered agent `agent`'s open decision, if any: the door lets each assignment ask one at a time, worked out from `list`, never stored. */
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

/** Whether Life withdrew it because he answered in its draft's chat himself (not its asker's own withdrawal). */
const isAnsweredInChat = (w?: Withdrawn) => w?.answeredInChatAt !== undefined;

/** "Someone wrote since" counts from his last attempt that went nowhere, else from the card. */
const sinceOf = (d: Pick<Decision, "at" | "notSent">) =>
  new Date(d.notSent?.at ?? d.at);

/** Why Life withdraws a card whose chat he answered himself, as its asker reads it. */
const ANSWERED_IN_CHAT = "he answered in the chat himself";

/**
 * Withdraws each open card whose draft's chat he wrote in since it was asked (`sinceOf`), by code: only that he wrote
 * acts (`fromMe`), never what; anyone else's message leaves it open (its send is refused). Its asker hears
 * `decision.withdrawn`. Run by the watcher every 30 s. Returns the ids withdrawn.
 * ponytail: a mail draft, or a new 1:1 chat by its number, has no chat key, so it is never withdrawn.
 */
export function withdrawDraftsAnsweredInChat(
  now = clock(),
  wrote = wroteSince
) {
  const open = decisionsNow(now).flatMap((d) =>
    d.state === "open" && d.draft?.chat ? [{ d, draft: d.draft }] : []
  );
  const found = wrote(
    open.map(({ d, draft }) => ({ draft, since: sinceOf(d) }))
  );
  const lines = open.flatMap(({ d }, i): Withdrawn[] => {
    const his = found[i]?.find((e) => e.fromMe);
    return his
      ? [
          {
            answeredInChatAt: his.at,
            at: now.toISOString(),
            id: d.id,
            kind: "withdrawn",
            schemaVersion: VERSION,
            why: ANSWERED_IN_CHAT,
          },
        ]
      : [];
  });
  appendJsonl(DECISIONS, Withdrawn, lines);
  return lines.map((l) => l.id);
}

/** One open draft per chat: throws when an open card's draft goes into `draft`'s chat; a second would be refused at its send anyway (the first's message is "someone wrote since"). */
function refuseSecondDraft(draft: StoredDraft | undefined, now: Date) {
  const same =
    draft?.chat &&
    decisionsNow(now).find(
      (d) =>
        d.state === "open" &&
        d.draft?.channel === draft.channel &&
        d.draft?.chat === draft.chat
    );
  if (same) {
    throw new Error(
      `Not done: ${same.id} already asks a draft into ${draft.to}; wait until it is answered or withdrawn, then read the chat again.`
    );
  }
}

/** Withdraws the open decision `request.withdraw`, only by the asker that asked it. */
function withdrawDecision(asker: string, request: object, now: Date) {
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

/**
 * Records a decision `asker` (an agent's pairing, or `desk`) asks, or its withdrawal by that same asker. A draft's chat
 * is resolved now (`readChat`), so his card names it and nothing is sent to a chat he didn't see.
 */
export async function requestDecision(
  asker: string,
  // An agent's arguments arrive unchecked (`DecisionRequest` is loose where the contract grows); `Ask` checks them here.
  request: Record<string, unknown>,
  now = clock(),
  readChat = resolveDraft
): Promise<{ id: string }> {
  if (request.withdraw) {
    return withdrawDecision(asker, request, now);
  }
  const notBuilt = notBuiltOf(request);
  if (notBuilt) {
    throw new Error(`Not done: ${notBuilt} is not built yet.`);
  }
  const parsed = Ask.safeParse(request);
  if (!parsed.success) {
    throw new Error(
      `Not done: ${z.prettifyError(parsed.error)}${pageHintOf(request, parsed.error)}`
    );
  }
  const ask = parsed.data;
  const problem = cardProblemOf(ask, now);
  if (problem) {
    throw new Error(`Not done: ${problem}.`);
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
  refuseSecondDraft(draft, now);
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

/** What makes an answer to `d` refused, in words; false when nothing does. An act (`actOfOption`) is his own app's alone: a send `via` the connector, an end or a look only where host gives `end` or `look` (`canEnd`, `canLook`). */
function answerProblemOf(
  d: Omit<Decision, "state">,
  options: string[],
  note: string | undefined,
  {
    canEnd,
    canLook,
    via,
  }: { canEnd: boolean; canLook: boolean; via: Answered["via"] }
) {
  const unknown = options.filter((o) => !d.options.some((x) => x.id === o));
  const picked = d.options.filter((o) => options.includes(o.id));
  const acts = picked.map((o) => actOfOption(d, o));
  const wordless = note ? undefined : picked.find((o) => o.takes);
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
      "a step is closed only on his own answer, through `answer_check` in his app.") ||
    (acts.includes("look") &&
      !canLook &&
      "Life looks for a step done only on his own answer, through `answer_check` in his app.") ||
    (wordless && `${wordless.id} takes his words: give them as \`note\`.`)
  );
}

/** Looks once for the card `d`'s step done (host: `lookForDone`): the event seen, or none; throws when it could not look. */
export type LookForDone = (
  d: Omit<Decision, "state">
) => Promise<string | undefined>;

/** Appends Life's outcome of a look for `id`'s step done: `seen` with its event, or `not_found` (with the look's error). Never his answer. */
export function recordDoneSeen(
  id: string,
  outcome: Pick<DoneSeen, "error" | "eventId" | "state">,
  now = clock()
) {
  const line: DoneSeen = {
    at: now.toISOString(),
    id,
    kind: "done-seen",
    schemaVersion: VERSION,
    ...outcome,
  };
  appendJsonl(DECISIONS, DoneSeen, [line]);
  return line;
}

/** His answer's look (`look`): `looking`, then its outcome line (`done_seen`); a failed look found nothing, with its error. */
async function lookOnAnswer(
  d: Omit<Decision, "state">,
  look: LookForDone,
  onStep?: (step: string, detail?: Record<string, unknown>) => void
) {
  onStep?.("looking");
  const outcome = await look(d).then(
    (eventId) =>
      eventId
        ? { eventId, state: "seen" as const }
        : { state: "not_found" as const },
    (e: Error) => ({ error: e.message, state: "not_found" as const })
  );
  const line = recordDoneSeen(d.id, outcome);
  onStep?.("done_seen", doneSeenShownOf(line) ?? undefined);
  return line;
}

/** Life's outcome as his card and app show it: its state and Life's words for it; null when Life looked for nothing. */
export function doneSeenShownOf(l?: DoneSeen) {
  if (!l) {
    return null;
  }
  const notFound = l.error
    ? `Life could not look in your accounts: ${l.error}`
    : "Not in your accounts yet";
  return {
    line: l.state === "seen" ? "Paid: Life saw it in your accounts" : notFound,
    state: l.state,
  };
}

/** What a decision's card holds beyond every check's shape (`checks.ts`): its needs with their lines, how and whether Life saw it done, its options with what each takes, its last send that did not go. */
export const decisionCardOf = (d: Decision) => ({
  doneSeen: doneSeenShownOf(d.doneSeen),
  doneSeenBy: doneSeenByOf(d),
  needs: needsShownOf(d.needs),
  notSent: notSentOf(d),
  options: d.options.map((o) => ({ ...o, takes: o.takes ?? null })),
});

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
    look,
    now = clock(),
    onStep,
    via = "session",
  }: {
    answerKey?: string;
    deliver?: typeof sendDraft;
    end?: EndByHisWord;
    look?: LookForDone;
    now?: Date;
    onStep?: (step: string, detail?: Record<string, unknown>) => void;
    via?: Answered["via"];
  } = {}
) {
  const d = readOpenDecision(id, now);
  const problem = answerProblemOf(d, options, note, {
    canEnd: Boolean(end),
    canLook: Boolean(look),
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
  // A look that never finished is only worked out when read: write its `not_found`, so this answer is the one kept.
  if (d.doneSeen?.state === "not_found" && readAll().get(id)?.answer) {
    appendJsonl(DECISIONS, DoneSeen, [d.doneSeen]);
  }
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
  if (act === "look" && look) {
    return [line, await lookOnAnswer(stored, look, onStep)];
  }
  if (!(act === "send" && isSendable(stored.draft))) {
    return [line];
  }
  const outcome = await deliver(stored.draft, id, {
    onStep,
    since: sinceOf(stored),
  }).then(
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
 * (none while the act runs), else his answer's instant, the withdrawal's line (never his message's instant, which a
 * poll's window may have passed), or the deadline for a lapse.
 */
export const settledAtOf = (d: Decision) => {
  if (d.state === "seen") {
    return d.doneSeen?.at;
  }
  const act = actDueOf(d);
  return act
    ? actOutcomeOf(d, act)?.at
    : (d.answer?.at ??
        d.withdrawn?.at ??
        // A lapse whose answer a `not sent:` voided after the deadline settles then, so a poll past the deadline still sees it.
        (d.notSent && d.notSent.at > d.deadline ? d.notSent.at : d.deadline));
};

/**
 * The decisions answered, seen done, lapsed, or withdrawn because he answered in the chat in [`from`, `to`), by when
 * they settled (`settledAtOf`; the asker's own withdrawal is its own act). Half-open, so a poll's next window starts at
 * this one's end and none is seen twice or skipped.
 */
export const settledBetween = (list: Decision[], from: Date, to: Date) =>
  list
    .map((d) => ({ at: Date.parse(settledAtOf(d) ?? ""), d }))
    .filter(
      ({ at, d }) =>
        (d.state === "answered" ||
          d.state === "lapsed" ||
          d.state === "seen" ||
          (d.state === "withdrawn" && isAnsweredInChat(d.withdrawn))) &&
        at >= from.getTime() &&
        at < to.getTime()
    )
    .toSorted((a, b) => a.at - b.at)
    .map((x) => x.d);
