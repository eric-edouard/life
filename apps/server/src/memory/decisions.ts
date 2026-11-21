import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { clock, MIN } from "../core/clock";
import { appendJsonl, readAppended } from "../core/files";
import { log } from "../core/log";
import { payments } from "../payments/backend";
import {
  cardProblemOf,
  endsProblemOf,
  notBuiltOf,
  pageHintOf,
} from "./card-problems";
import { Ask, Keep, type Option, Withdrawal } from "./card-request";
import {
  Answered,
  type Asked,
  DECISIONS_VERSION,
  type Decision,
  type DecisionState,
  DoneSeen,
  Ended,
  Kept,
  Line,
  SendFailed,
  Sent,
  Stored,
  Withdrawn,
  withdrawnOf,
} from "./decision-lines";
import { isSendable } from "./draft";
import {
  contestOf,
  heldChatOf,
  isPending,
  isSameChat,
  mergeWithdrawalsOf,
  waitingOnOf,
  waitsOf,
} from "./draft-contest";
import { resolveDraft, sendDraft, sendLimitMs, wroteSince } from "./draft-send";
import { contextProblemOf, readsOnce, refsProblemOf } from "./find-refs";
import { matterOfSteps, openStepsOf } from "./matter-read";
import { MEMORY } from "./memory-files";
import { amountOf, needRefsOf } from "./needs";

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
// which settles the card with no answer of his (`seen`). A card whose draft goes into a chat another asker's open card
// holds waits on it (`contests`, Life's stamp; his yes of 21 Nov 2026): the holder yields (withdraws its own), merges
// (`merges`: one card for both) or keeps (`kept`, with its why); silent `CONTEST_WAIT`, the waiting card is asked with
// `replaces`, and his Send withdraws the older card (`replacedBy`). Where each
// stands is worked out when read (`decisionsNow`); the open ones are checks (`checks.ts`), so he sees them in the one
// list. The file also holds earlier versions' lines: the old decisions page's (schemaVersion 1, before 2 Nov 2026) and
// the cards before titles (schemaVersion 2, none in his data on 18 Nov 2026): kept, never read.

export const DECISIONS = join(MEMORY, "decisions.jsonl");

const PROJECT_OR_AREA = /^(?:project|area):/;

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
    case "kept":
      return d.kept ? d : { ...d, kept: l };
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
      if (l.schemaVersion !== DECISIONS_VERSION) {
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

/** How Life sees `d`'s step done now: `payment` while payments are on (amendment 1: a card with no channel to look in is `tap`), else `tap`. */
export const doneSeenByOf = (
  d: Pick<Decision, "doneSeenBy" | "needs">
): "payment" | "tap" =>
  d.doneSeenBy === "payment" && payments() && amountOf(d.needs)
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
    schemaVersion: DECISIONS_VERSION,
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

/** Every decision with where it stands at `now`: open, waiting (on another card holding its chat), answered, seen (Life saw its step done, no answer of his), lapsed (its deadline passed) or withdrawn. */
export function decisionsNow(now = clock()): Decision[] {
  const own = [...readAll().values()].map((d) => {
    const o = withOutcomeOf(d, now);
    return { ...o, state: stateOf(o, now) };
  });
  const byId = new Map(own.map((d) => [d.id, d]));
  const mergers = new Map(
    own.flatMap((d) => (d.merges ? [[d.merges, d] as const] : []))
  );
  return own.map((d) => {
    const held = byId.get(d.contests ?? "");
    const merger = mergers.get(d.id);
    // A merge is final: the card it settled never lapses after it.
    const isContested =
      d.state === "open" || (merger !== undefined && d.state === "lapsed");
    // A send running into its chat holds every card contesting there, however they chain.
    const isSending = own.some((x) => isSendingOf(x) && isSameChat(x, d));
    return d.contests && isContested
      ? contestOf(d, held, merger, isSending, now)
      : d;
  });
}

/** A new card's contest: the card its merge settles with the asker's own held card, and the card it waits on. */
function contestOfAsk(
  ask: Pick<Decision, "agent" | "merges">,
  asker: string,
  draft: Decision["draft"],
  now: Date
) {
  const by = { agent: ask.agent, asker };
  const all = decisionsNow(now);
  const merged = ask.merges ? waitingOnOf(all, ask.merges, by) : undefined;
  const merging = merged ? [merged.held.id, merged.waiting.id] : [];
  return {
    contests: heldChatOf(all, draft, by, merging, isSendingOf),
    merged,
  };
}

/** Whether his answer to `d` started sending its draft and its outcome is not in: its chat is still held. */
const isSendingOf = (d: Decision) =>
  d.state === "answered" && actDueOf(d) === "send" && !d.send;

/** Decision `id` while it is open (`isWaitingToo`: or waiting); throws otherwise. */
function readOpenDecision(id: string, now: Date, isWaitingToo = false) {
  const d = decisionsNow(now).find((x) => x.id === id);
  if (!d) {
    throw new Error(`Not done: no decision ${id}.`);
  }
  if (!(d.state === "open" || (isWaitingToo && d.state === "waiting"))) {
    throw new Error(
      `Not done: ${id} is ${d.state}${d.answer ? ` (${d.answer.at})` : ""}.`
    );
  }
  return d;
}

/** Whether a decision's subject is a matter step (else a project, an area or none). */
export const isOnMatter = (subject?: string): subject is string =>
  subject !== undefined && !PROJECT_OR_AREA.test(subject);

/** Whether its asker did not withdraw it itself: he answered in its draft's chat himself, or another card took its place (`replacedBy`). */
const isWithdrawnForIt = (w?: Withdrawn) =>
  w?.answeredInChatAt !== undefined || w?.replacedBy !== undefined;

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
      ? [withdrawnOf(d.id, now, ANSWERED_IN_CHAT, { answeredInChatAt: his.at })]
      : [];
  });
  appendWithdrawals(lines, "life");
  return lines.map((l) => l.id);
}

/** Withdrawals appended in one write, each one `decision.withdrawn` line by `by` (who withdrew it). */
function appendWithdrawals(lines: Withdrawn[], by: string) {
  appendJsonl(DECISIONS, Withdrawn, lines);
  logWithdrawn(by, lines);
}

/** One `decision.withdrawn` line for each card withdrawn, by `by` (who withdrew it). */
const logWithdrawn = (by: string, cards: { id: string }[]) => {
  for (const { id } of cards) {
    log("decision.withdrawn", { by, id });
  }
};

/** The holder's keep (`request.keep`): the card waiting on its open card stays waiting until that one settles, and its asker hears why. */
function keepDraft(asker: string, request: object, now: Date) {
  const k = Keep.safeParse(request);
  if (!k.success) {
    throw new Error(`Not done: ${z.prettifyError(k.error)}`);
  }
  const { waiting } = waitingOnOf(decisionsNow(now), k.data.keep, {
    agent: k.data.agent,
    asker,
  });
  appendJsonl(DECISIONS, Kept, [
    {
      at: now.toISOString(),
      id: waiting.id,
      kind: "kept",
      schemaVersion: DECISIONS_VERSION,
      why: k.data.why,
    },
  ]);
  return { id: waiting.id };
}

/** Withdraws the open decision `request.withdraw`, only by the asker that asked it. */
function withdrawDecision(asker: string, request: object, now: Date) {
  const w = Withdrawal.safeParse(request);
  if (!w.success) {
    throw new Error(`Not done: ${z.prettifyError(w.error)}`);
  }
  const d = readOpenDecision(w.data.withdraw, now, true);
  // Every registered agent asks as `desk`: its own `agent` tells them apart.
  if (d.asker !== asker || d.agent !== w.data.agent) {
    throw new Error(`Not done: ${d.id} was asked by another agent.`);
  }
  appendWithdrawals([withdrawnOf(d.id, now, w.data.why)], "asker");
  return { id: d.id };
}

/**
 * Records a decision `asker` (an agent's pairing, or `desk`) asks, or its withdrawal by that same asker, or its keep
 * (`keepDraft`). A draft's chat is resolved now (`readChat`), so his card names it and nothing is sent to a chat he
 * didn't see; into a chat another asker's open card holds, the card waits on it (`waits`). `held`, the desk's for an
 * assignment's card: its `claim`, `prefer` (its matter, taken on a tie) and `isPlan` (its plan card, `asksPlanOf`).
 */
export function requestDecision(
  asker: string,
  // An agent's arguments arrive unchecked (`DecisionRequest` is loose where the contract grows); `Ask` checks them here.
  request: Record<string, unknown>,
  now = clock(),
  readChat = resolveDraft,
  held?: Held
): Promise<{ id: string; waits?: { on: string; until: string; why: string } }> {
  // A withdrawal or a keep refuses as a rejection too, like an ask.
  if (request.withdraw) {
    return Promise.try(() => withdrawDecision(asker, request, now));
  }
  return request.keep
    ? Promise.try(() => keepDraft(asker, request, now))
    : askCard(asker, request, now, readChat, held);
}

interface Held {
  claim: Claim;
  isPlan: boolean;
  prefer?: string;
}

/** Whose a card is (the desk's claim): handed the subject Life will store, the card's id, the asker's own card a merge withdraws and the card's write, which it runs at once inside its own writes (whose card it is), or refuses by throwing. */
type Claim = (
  subject: string | undefined,
  id: string,
  replacing: string | undefined,
  write: (stamps: Pick<Asked, "assignment">) => void
) => void;

/** A new card (`requestDecision`): checked, its draft's chat resolved and its contest found, then written. */
async function askCard(
  asker: string,
  request: Record<string, unknown>,
  now: Date,
  readChat: typeof resolveDraft,
  {
    claim = (_subject, _id, _replacing, write) => write({}),
    isPlan = false,
    prefer,
  }: Partial<Held> = {}
) {
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
  const problem = cardProblemOf(ask, now, isPlan);
  if (problem) {
    throw new Error(`Not done: ${problem}.`);
  }
  // A step no open matter holds would never be listed: refused, so no question goes unseen. A matter's own id rides on
  // its newest step: a step outlives a re-group, a matter id doesn't.
  const reads = readsOnce();
  const contextProblem =
    (await contextProblemOf(ask.context, reads)) ??
    (await refsProblemOf(
      needRefsOf(ask.needs),
      reads,
      (id) => `the qr need's \`ref\` ${id}`,
      "a QR's `ref`"
    ));
  if (contextProblem) {
    throw new Error(`Not done: ${contextProblem}.`);
  }
  const matter = isOnMatter(ask.subject)
    ? matterOfSteps(
        (await reads.book()).filter((m) => m.open),
        [ask.subject],
        prefer
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
  const { contests, merged } = contestOfAsk(ask, asker, draft, now);
  const id = `dec_${randomBytes(6).toString("hex")}`;
  const { draft: _given, ...given } = ask; // The draft is stored as Life resolved it.
  const write = (stamps: Pick<Asked, "assignment">) =>
    appendJsonl(DECISIONS, Line, [
      ...mergeWithdrawalsOf(merged, id, now), // A merge's withdrawal, in the same append as its card.
      {
        ...given,
        ...stamps,
        ...(matter ? { matter: matter.id } : {}),
        ...(contests ? { contests } : {}),
        ...(draft ? { draft } : {}),
        ...(subject ? { subject } : {}),
        asker,
        at: now.toISOString(),
        // In UTC, so deadlines sort as strings (`checksOf`).
        deadline: new Date(ask.deadline).toISOString(),
        id,
        kind: "asked",
        schemaVersion: DECISIONS_VERSION,
      },
    ]);
  claim(subject, id, merged?.held.id, write);
  logAsked(ask, asker, id, !!draft, merged);
  return { id, ...waitsOf(contests, draft, now) };
}

/** A card's `decision.asked` line, after the `decision.withdrawn` lines of both cards a merge withdraws. */
function logAsked(
  ask: z.infer<typeof Ask>,
  asker: string,
  id: string,
  hasDraft: boolean,
  merged?: { held: Decision; waiting: Decision }
) {
  logWithdrawn("merge", merged ? [merged.held, merged.waiting] : []);
  const options = ask.options.length;
  log("decision.asked", {
    agent: ask.agent,
    asker,
    draft: hasDraft,
    id,
    options,
  });
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
    (d.plan && new Set(options).size > 1 && "a plan card takes one pick.") ||
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
    schemaVersion: DECISIONS_VERSION,
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
    schemaVersion: DECISIONS_VERSION,
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
    schemaVersion: DECISIONS_VERSION,
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
  log("decision.answered", { id, note: !!note, options: options.length, via });
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
  // His Send withdraws every other card into its chat first, open or waiting (the one it `replaces`, any other a
  // contest opened): one draft per chat when it goes.
  appendWithdrawals(
    decisionsNow(now)
      .filter((x) => x.id !== id && isPending(x) && isSameChat(x, d))
      .map((x) =>
        withdrawnOf(x.id, now, "he sent a newer draft into its chat instead", {
          replacedBy: id,
        })
      ),
    "send"
  );
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
    schemaVersion: DECISIONS_VERSION,
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
 * The decisions answered, seen done, lapsed, or withdrawn for their asker (`isWithdrawnForIt`) in [`from`, `to`), by when
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
          (d.state === "withdrawn" && isWithdrawnForIt(d.withdrawn))) &&
        at >= from.getTime() &&
        at < to.getTime()
    )
    .toSorted((a, b) => a.at - b.at)
    .map((x) => x.d);
