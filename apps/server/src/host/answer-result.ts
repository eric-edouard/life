import { clock, MIN } from "../core/clock";
import { LIFE_ASKER, OWNER_ASKER } from "../core/names";
import {
  answerCheck,
  type CheckAnswer,
  LATER,
  type StartAgent,
  yourMoveClosingOf,
} from "../memory/answer-check";
import { atOrganizationPairOf } from "../memory/at-organization";
import { ADD_LIMIT_MS, RUN_LIMIT_MS } from "../memory/decision-add";
import { notSentOf, withdrawAnswer } from "../memory/decision-after-answer";
import { type Decision, doneSeenShownOf } from "../memory/decision-lines";
import {
  actDueOf,
  actOf,
  actOutcomeOf,
  decisionsNow,
  type EndByHisWord,
  LOOK_LIMIT_MS,
} from "../memory/decisions";
import {
  sendLimitMs,
  sendStepsOf,
  unsendDraft,
  unsendLineOf,
} from "../memory/draft-send";
import type { Check } from "../memory/life-checks";
import {
  isAwaitingHisWord,
  type MatterStepNow,
  matterOfSteps,
  openStepsOf,
} from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { samePersonPairOf } from "../memory/same-person";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { runApifyByHisWord } from "./card-apify-run";
import { addEventByHisWord } from "./card-event-calendar";
import {
  addDirectoryEntryByHisWord,
  addOrganizationPersonByHisWord,
} from "./change-directory-entry";
import {
  changeRegisteredAgent,
  START_STAGES,
  WAIT_MS,
} from "./change-registered-agent";
import {
  closedStepOf,
  endByHisWord,
  QUICK_MS,
  ticksLimitMsOf,
} from "./correct-matter";
import {
  assignmentOf,
  assignmentOfCard,
  eventHeard,
  readDesk,
} from "./desk-read";
import { lookForDone } from "./done-seen";
import type { ToolCall } from "./http/mcp-tool";
import { openCheckOf } from "./inbox";

// His answer to a check, with proof (`answer_check`): what was written, what changed, what a send did, whether the
// asker was told. Nothing is stored here: each fact is read again from the store that owns it (the decisions' lines,
// the desk's event rows), so this only composes them. It returns once the answer line, and its act's outcome if any
// (a send's, or an end's: an `ends` option picked alone closes its step or matter by his word, `endByHisWord`), is stored: nothing waits for the asker or the inbox (the app reads its inbox again after every answer). Steps go out
// as they pass (`report`, `mcp-tool.ts`) after the plan: the steps to come and the most seconds they may take.

const POLL_MS = 500;

const at = () => clock().toISOString();

/** Whether the desk has the answer of decision `d` queued for its registered agent (one read, no wait), else why not. */
function askerOf(d: Decision) {
  // Not answered: a `not sent:` outcome reopened the card, and the asker hears only once it really settles.
  if (!d.answer) {
    return { name: d.asker, told: "not_told" };
  }
  const act = actDueOf(d);
  if (act && !actOutcomeOf(d, act)) {
    return { name: d.asker, told: "not_yet", why: `the ${act} has not ended` };
  }
  // He asked it himself: his answer is all there is to tell.
  if (d.asker === OWNER_ASKER) {
    return { name: d.asker, told: "recorded" };
  }
  const { agent } = d;
  if (!agent) {
    return { name: d.asker, told: "on_its_next_poll" };
  }
  const read = readDesk(
    (db) => {
      const s = assignmentOf(db, assignmentOfCard(db, d) ?? "");
      const heard = eventHeard(db, s?.id ?? "", `${d.id}.answered`);
      // Told to the agent whose turn took it, else the one holding its card now (after a fold or a move), whoever asked it.
      return { holder: heard.by ?? s?.agent_id ?? agent, told: heard.told };
    },
    { holder: agent, told: "not_yet" as const }
  );
  if (read.state !== "ok") {
    return {
      agent,
      name: d.asker,
      told: "not_yet",
      why: read.state === "off" ? "the desk is off" : read.why,
    };
  }
  return {
    agent: read.value.holder,
    at: at(),
    name: d.asker,
    told: read.value.told,
    ...(read.value.told === "not_yet"
      ? { why: "the desk has not queued it yet" }
      : {}),
  };
}

/** The tap `key` made (the newest without a key): its answer, the outcome of its send or look, or the one that voided it. */
function tapOf(d: Decision, key?: string) {
  if (d.answer && (!key || d.answer.answerKey === key)) {
    return {
      answer: d.answer,
      doneSeen: d.doneSeen,
      notSent: undefined,
      send: d.send,
    };
  }
  const v = key
    ? d.voided?.find((x) => x.answer.answerKey === key)
    : d.voided?.at(-1);
  return {
    answer: v?.answer,
    doneSeen: v?.doneSeen,
    notSent: v?.notSent,
    send: undefined,
  };
}

/** What a tap's send did, as the app shows it: none when it sends nothing. */
function sendResultOf(d: Decision, tap: ReturnType<typeof tapOf>) {
  if (tap.notSent) {
    return { ...notSentOf(d, tap.notSent), state: "not_sent" };
  }
  if (tap.send?.kind === "sent") {
    return {
      at: tap.send.at,
      channel: d.draft?.channel,
      eventId: tap.send.eventId,
      state: "sent",
      to: d.draft?.to,
    };
  }
  if (tap.send) {
    return {
      at: tap.send.at,
      canRetry: false,
      reason: tap.send.error,
      state: "may_have_gone",
    };
  }
  return tap.answer && actDueOf(d) === "send" ? { state: "pending" } : null;
}

/** An act's outcome line as the proof shows it: when, and its error or what it made, without its line's bookkeeping. */
const shownOutcomeOf = <L extends { at: string; error?: string }>(
  line: L | undefined,
  made: "eventId" | "runId" | null
) =>
  line && {
    at: line.at,
    ...(line.error ? { error: line.error } : {}),
    ...(made && made in line ? { [made]: line[made as keyof L] } : {}),
  };

/** The answer's proof for a decision, composed from what is stored. */
async function decisionResult(ref: string, key?: string) {
  let d = decisionsNow().find((x) => x.id === ref) as Decision;
  // A repeat arrives while the first call's send still runs (a dropped stream): wait for its outcome, never send.
  const end = performance.now() + (d.draft ? sendLimitMs(d.draft) : 0);
  while (actDueOf(d) === "send" && !d.send && performance.now() < end) {
    // biome-ignore lint/performance/noAwaitInLoops: polling the decisions' lines
    await Bun.sleep(POLL_MS);
    d = decisionsNow().find((x) => x.id === ref) as Decision;
  }
  const tap = tapOf(d, key);
  // An end belongs to the answer that stands: one a `not sent:` outcome voided ended nothing.
  const ended = tap.answer === d.answer ? d.end : undefined;
  const added = tap.answer === d.answer ? d.added : undefined;
  const ran = tap.answer === d.answer ? d.ran : undefined;
  return {
    asker: askerOf(d),
    changed: {
      added: shownOutcomeOf(added, "eventId"),
      decision: ref,
      ended: shownOutcomeOf(ended, null),
      options: tap.answer?.options ?? [],
      ran: shownOutcomeOf(ran, "runId"),
      state: d.state,
    },
    done: [
      tap.answer,
      tap.notSent ?? tap.send,
      tap.doneSeen,
      ended,
      added,
      ran,
    ].filter(Boolean),
    doneSeen: doneSeenShownOf(tap.doneSeen, d.needs),
    kind: "decision",
    ref,
    send: sendResultOf(d, tap),
    start: null,
  };
}

const VOICE_ANSWER: Record<string, string> = {
  "is-them": "named",
  media: "media",
  "not-anyone-i-know": "not_anyone",
  "not-relevant": "not_relevant",
  "this-is": "named",
};

/** What each kind of check changed, from the check and his answer. */
function changedOf(c: Check, a: CheckAnswer, done: unknown[]) {
  if (a.options[0] === LATER || a.options[0] === "not-now") {
    return {
      answer: LATER,
      until: (done[0] as { until?: string } | undefined)?.until,
    };
  }
  if (c.group === "ending") {
    return {
      ending: a.options[0] === "outdated" ? "done" : "reopened",
      matter: c.matter,
      step: c.ref,
    };
  }
  if (c.group === "new matter") {
    return {
      answer: a.options[0],
      matter: c.matter,
      ...(a.options[0] === "edit-goal" ? { goal: a.note } : {}),
    };
  }
  if (c.group === "your move") {
    return { answer: a.options[0], matter: c.matter, step: c.subject };
  }
  if (c.group === "at organization") {
    return { answer: a.options[0], ...atOrganizationPairOf(c.ref) };
  }
  if (c.group === "voice") {
    const answered = done[0] as { personId?: string } | undefined;
    return {
      answer: VOICE_ANSWER[a.options[0] ?? ""],
      person: answered?.personId ?? null,
    };
  }
  return {
    corrections: done.length,
    names: c.about,
    // A same person card's ref is the pair: its person is the other, whom the guess joins on "Same person".
    person:
      c.group === "same person"
        ? samePersonPairOf(c.ref).other
        : (a.person ?? c.ref),
  };
}

/** A non-decision answer's result by check and answer, kept in memory a while: a repeat after a dropped connection gets it, not "no open check". */
const TAP_MEMORY_MS = 10 * MIN;
const taps = new Map<string, { at: number; result: Record<string, unknown> }>();

function rememberedTap(key: string) {
  const tap = taps.get(key);
  return tap && !(clock().getTime() - tap.at > TAP_MEMORY_MS)
    ? tap.result
    : undefined;
}

function forgetTaps(ref: string) {
  for (const k of taps.keys()) {
    if (k.startsWith(`${ref}|`)) {
      taps.delete(k);
    }
  }
}

function rememberTap(key: string, result: Record<string, unknown>) {
  const t = clock().getTime();
  for (const [k, v] of taps) {
    if (t - v.at > TAP_MEMORY_MS) {
      taps.delete(k);
    }
  }
  taps.set(key, { at: t, result });
}

/** The steps an answer will report, in order: a decision's (and its send's, or its end's ticks), a new matter's Start (the desk's start stages), else Life's guesses' (a your move's ticks, or removals on Drop: `isDropped`). */
function planOf(
  known: Decision | undefined,
  act: ReturnType<typeof actOf>,
  closing: readonly MatterStepNow[],
  starts: boolean,
  isDropped: boolean
) {
  if (known) {
    return [
      "recorded",
      ...(act === "send" && known.draft ? sendStepsOf(known.draft) : []),
      ...(act === "end" && closing.some((s) => s.kind === "todo_item")
        ? [closedStepOf(false)]
        : []),
      ...(act === "end" ? ["ended"] : []),
      ...(act === "look" ? ["looking", "done_seen"] : []),
      ...(act === "add" ? ["added"] : []),
      ...(act === "run" ? ["ran"] : []),
    ];
  }
  if (starts) {
    return ["goal_saved", ...START_STAGES, "recorded"];
  }
  // A your move's Mark as done or Drop: its ticks or removals, then the answer recorded.
  return [
    ...(closing.some((s) => s.kind === "todo_item")
      ? [closedStepOf(isDropped)]
      : []),
    "recorded",
  ];
}

/**
 * What his pick of `d`'s `ends` option `option` closes (`openStepsOf`): the open steps of the matter it was asked on
 * (`matter`; none once that matter ended), else of the open matter its subject rides on (`matterOfSteps`), or the
 * subject alone for a step's card. Read before the plan, so its limit counts the ticks. `problem`: a step's card whose step is neither open nor ended (no
 * open matter holds it), so closing would close nothing; a step already ended by another route is no problem.
 */
async function closingOf(d: Decision, option: string) {
  const book = await readMatterBook(await readPeople(), dayNow());
  const step = d.options.find((o) => o.id === option)?.ends === "step";
  // The matter it was asked on, found in the whole book first: one with no step left for his word closes nothing, never
  // another sharing its step; a card from before it was kept, or a matter re-grouped away, by its subject among the matters
  // with such steps (a matter Life reads over, or a link ended, still waits on his word).
  const asked = book.find((m) => m.id === d.matter);
  const v =
    asked && !isAwaitingHisWord(asked)
      ? undefined
      : (asked ??
        (d.subject &&
          matterOfSteps(
            book.filter(isAwaitingHisWord),
            [d.subject],
            d.matter
          )));
  const closing = v ? openStepsOf(v, step ? d.subject : undefined) : [];
  const isEnded = book.some((m) =>
    m.steps.some((s) => s.ref === d.subject && s.ending)
  );
  return {
    closing,
    problem:
      step && closing.length === 0 && !isEnded
        ? `Not done: no open matter holds ${d.subject} open; nothing was closed.`
        : undefined,
  };
}

/**
 * What his answer to the decision `known` does besides being recorded (`actOf`), and the most it may take: a send's
 * path's limit, or an end's ticks; with the steps an `ends` option closes (read now, so the limit counts their ticks)
 * and the `end` that closes them by his word, with Life's words naming the card.
 */
async function decisionActOf(
  known: Decision | undefined,
  a: CheckAnswer,
  report: ToolCall["report"]
) {
  const act =
    known?.state === "open" ? actOf(known, a.options, a.note) : undefined;
  const { closing, problem } =
    known && act === "end"
      ? await closingOf(known, a.options[0] ?? "")
      : { closing: [], problem: undefined };
  const end: EndByHisWord = async (d) => {
    if (problem) {
      throw new Error(problem);
    }
    return await endByHisWord(
      closing,
      `"${d.options.find((o) => o.id === a.options[0])?.label}" on "${d.title}" (${d.id})`,
      (ticked, of, key) =>
        report({ at: at(), done: ticked, key, of, step: closedStepOf(false) })
    );
  };
  const sendMs = act === "send" && known?.draft ? sendLimitMs(known.draft) : 0;
  const lookMs = act === "look" ? LOOK_LIMIT_MS : 0;
  const addMs = act === "add" ? ADD_LIMIT_MS : 0;
  const runMs = act === "run" ? RUN_LIMIT_MS : 0;
  return {
    act,
    closing,
    end,
    limitMs: sendMs + lookMs + addMs + runMs + ticksLimitMsOf(closing),
  };
}

/** Whether an answer to `c` is the decision's own (its proof is the decision's), not his Later on it. */
const isDecisionAct = (c: Check, a: CheckAnswer) =>
  c.group === "decision" && a.options[0] !== LATER;

/** What an answer says, to tell a repeat of it from another answer. */
const saidOf = (a: CheckAnswer) =>
  JSON.stringify([a.options, a.note || null, a.person ?? null, a.name ?? null]);

/** The stored result of a repeat, or undefined: the same answer again to an answered decision (under any key: nothing written, nothing sent; another answer is refused as before), or a tap a `not sent:` outcome voided. */
function repeatOf(
  known: Decision | undefined,
  ref: string,
  a: CheckAnswer,
  answerKey?: string
) {
  if (known?.answer && saidOf(known.answer) === saidOf(a)) {
    return decisionResult(ref, known.answer.answerKey);
  }
  return answerKey &&
    known?.voided?.some((v) => v.answer.answerKey === answerKey)
    ? decisionResult(ref, answerKey)
    : undefined;
}

async function answer(ref: string, a: CheckAnswer, call: ToolCall) {
  const { answerKey, report } = call;
  const known = decisionsNow().find((x) => x.id === ref);
  const repeated = repeatOf(known, ref, a, answerKey);
  if (repeated) {
    return repeated;
  }
  // One press is its key when his app gives one (a fresh press on a card that came back is a new answer), else what it says.
  const tapKey = `${ref}|${answerKey ?? saidOf(a)}`;
  const failedKey = `${ref}|${answerKey}`;
  const remembered =
    rememberedTap(tapKey) ?? (answerKey ? rememberedTap(failedKey) : undefined);
  if (remembered) {
    return remembered;
  }
  const open = await openCheckOf(ref);
  const { act, closing, end, limitMs } = await decisionActOf(known, a, report);
  const starts =
    (open.group === "new matter" || open.group === "your move") &&
    a.options[0] === "start";
  // A your move's Mark as done or Drop closes its step, read before the plan so its limit counts the tick.
  const isDropped = open.group === "your move" && a.options[0] === "drop";
  const moveClosing =
    open.group === "your move" && (a.options[0] === "done" || isDropped)
      ? await yourMoveClosingOf(open)
      : [];
  report({
    limitSeconds: Math.ceil(
      (limitMs +
        ticksLimitMsOf(moveClosing) +
        (starts ? WAIT_MS : 0) +
        QUICK_MS) /
        1000
    ),
    plan: planOf(known, act, known ? closing : moveClosing, starts, isDropped),
  });
  // A new matter's Start: the desk's start, as `change_registered_agent` asks it; its own plan is in this one.
  let start: Awaited<ReturnType<typeof changeRegisteredAgent>> | null = null;
  const startAgent: StartAgent = async (c, goal) => {
    start = await changeRegisteredAgent(
      // The matter's id: a new matter's ref, a your move card's matter.
      { action: "start", said: goal, step: c.matter?.id ?? c.ref },
      {
        ...call,
        report: (s) => {
          if (!s.plan) {
            report(s);
          }
        },
      }
    );
    return { ask: "ask" in start ? start.ask : "" };
  };
  const {
    answer: asRead,
    check,
    done,
    item,
    recordedAs,
  } = await answerCheck(open, a, "connector", {
    add: addEventByHisWord,
    addDirectoryEntry: (kind, name, fields) =>
      addDirectoryEntryByHisWord(kind, name, `New ${kind}: ${name}`, fields),
    addOrganizationPerson: (organization, person, role) =>
      addOrganizationPersonByHisWord(
        organization,
        person,
        role,
        `"Yes" to "${open.question}" (${open.ref})`
      ),
    answerKey,
    end,
    endYourMove: () =>
      endByHisWord(
        moveClosing,
        `"${isDropped ? "Drop" : "Mark as done"}" on "${open.title}" (${open.ref})`,
        (closed, of, key) =>
          report({
            at: at(),
            done: closed,
            key,
            of,
            step: closedStepOf(isDropped),
          }),
        isDropped
      ),
    look: lookForDone,
    onStep: (step, detail) => report({ at: at(), step, ...detail }),
    run: runApifyByHisWord,
    startAgent,
  });
  if (isDecisionAct(check, asRead)) {
    return decisionResult(ref, answerKey);
  }
  const result = {
    asker: { name: LIFE_ASKER, told: "recorded" },
    changed: {
      ...changedOf(check, asRead, done),
      ...(recordedAs ? { recordedAs } : {}),
      ...(item
        ? {
            conversations: new Set(item.voices.map((v) => v.jobId)).size,
            voices: item.voices.length,
          }
        : {}),
    },
    done,
    kind: check.group,
    ref,
    send: null,
    start,
  };
  // A fresh answer ends the earlier ones' memory (A, B, A is three answers). A Start the desk did not start stays
  // open for his next tap, which starts again; only the same tap's retry (same key) gets this result.
  forgetTaps(ref);
  if ((start as { state?: string } | null)?.state !== "not_started") {
    rememberTap(tapKey, result);
  } else if (answerKey) {
    rememberTap(failedKey, result);
  }
  return result;
}

/** The answers being recorded now, by check, with what each was given. */
const running = new Map<
  string,
  { call: ToolCall; result: Promise<Record<string, unknown>>; said: string }
>();

/**
 * Records his answer to the open check `ref` (`answerCheck`) and returns the proof: `done` (the lines written),
 * `changed`, `send`, `asker`. A repeat of an answered decision's answer, under any key, returns its first result and
 * writes and sends nothing (`call.answerKey` finds the tap of a send a `not sent:` outcome voided). A second call on the same check while one runs gets that one's result
 * when it gives the same answer; another answer is refused, whatever its key (none, or the same tap's).
 */
export function answerWithResult(ref: string, a: CheckAnswer, call: ToolCall) {
  const said = saidOf(a);
  const first = running.get(ref);
  if (first) {
    if (first.said !== said) {
      return Promise.reject(
        new Error(`Not done: another answer to ${ref} is being recorded.`)
      );
    }
    return first.result;
  }
  const result = answer(ref, a, call).finally(() => running.delete(ref));
  running.set(ref, { call, result, said });
  return result;
}

/** Whether the asker's turn took his answer to `d` (its `decision.answered` handed to a turn): then Undo can't stop it. */
const isTakenOf = (d: Decision) => {
  const r = readDesk(
    (db) =>
      db
        .query<{ n: number }, [string]>(
          "select count(*) as n from event where event_id = ? and handed > 0"
        )
        .get(`${d.id}.answered`)?.n ?? 0,
    0
  );
  return r.state === "ok" && r.value > 0;
};

/**
 * What his Undo of his answer to `d` would do now, or null when there is none: an answered card whose answer did nothing
 * outside Life yet (no end, event, run or look), or whose send its chat lets Life delete for everyone now (`line`, what
 * the other side will see), while the asker's turn has not taken it.
 */
export function undoOf(d: Decision, now = clock()) {
  const act = actDueOf(d);
  // An act still running (its outcome line not in yet) holds the card: an Undo now would let it send or end twice.
  const isRunning = act !== undefined && !actOutcomeOf(d, act);
  if (
    d.state !== "answered" ||
    isRunning ||
    d.end ||
    d.added ||
    d.ran ||
    d.doneSeen
  ) {
    return null;
  }
  if (d.send) {
    const line =
      d.send.kind === "sent" && d.draft
        ? unsendLineOf(d.draft, d.send.at, now)
        : undefined;
    return line && !isTakenOf(d) ? { line } : null;
  }
  return isTakenOf(d) ? null : { line: null };
}

/**
 * His Undo of his answer to card `ref` (`answer_check` with `undo`): a sent draft deleted for everyone first, where its
 * chat allows it (reported only once its network confirmed), then the answer withdrawn and the card open again. Refused,
 * with what was done, once the asker's turn took it or the answer did something outside Life; the desk's tick stops a
 * turn queued on it (`stopWithdrawn`).
 */
export function undoAnswer(ref: string) {
  // One answer or Undo on a card at a time, with the answers (`running`).
  if (running.has(ref)) {
    return Promise.reject(
      new Error(`Not done: another answer to ${ref} is being recorded.`)
    );
  }
  const result = undo(ref).finally(() => running.delete(ref));
  running.set(ref, { call: { report: () => undefined }, result, said: "undo" });
  return result;
}

async function undo(ref: string) {
  const d = decisionsNow().find((x) => x.id === ref);
  if (!d?.answer) {
    throw new Error(`Not done: ${ref} has no answer of his to undo.`);
  }
  if (!undoOf(d)) {
    throw new Error(
      d.send
        ? "Not done: the message went, and its chat doesn't let Life delete it now."
        : "Not done: what your answer started is under way, or its agent already acted on it."
    );
  }
  let unsent: string | undefined;
  if (d.send?.kind === "sent" && d.draft) {
    await unsendDraft(d.draft, d.send.eventId, d.send.at);
    unsent = d.send.eventId;
  }
  const line = withdrawAnswer(ref, unsent);
  return {
    changed: { decision: ref, deleted: Boolean(unsent), state: "open" },
    done: [line],
    kind: "decision",
    ref,
  };
}
