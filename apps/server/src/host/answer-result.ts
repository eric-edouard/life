import { clock, MIN } from "../core/clock";
import { LIFE_ASKER, OWNER_ASKER } from "../core/names";
import {
  answerCheck,
  type CheckAnswer,
  type StartAgent,
} from "../memory/answer-check";
import type { Check } from "../memory/checks";
import {
  type Decision,
  decisionsNow,
  isSendDue,
  notSentOf,
  sendsOn,
} from "../memory/decisions";
import { sendLimitMs, sendStepsOf } from "../memory/draft-send";
import {
  changeRegisteredAgent,
  START_STAGES,
  WAIT_MS,
} from "./change-registered-agent";
import { eventHeard, readDesk } from "./desk-read";
import type { ToolCall } from "./http/mcp-tool";
import { openCheckOf } from "./inbox";

// His answer to a check, with proof (`answer_check`): what was written, what changed, what a send did, whether the
// asker was told. Nothing is stored here: each fact is read again from the store that owns it (the decisions' lines,
// the desk's event rows), so this only composes them. It returns once the answer line, and the send's outcome if any,
// is stored: nothing waits for the asker or the inbox (the app reads its inbox again after every answer). Steps go out
// as they pass (`report`, `mcp-tool.ts`) after the plan: the steps to come and the most seconds they may take.

/** What an answer is given on top of its send and its Start: the reads. */
export const QUICK_MS = 5000;
const POLL_MS = 500;

const at = () => clock().toISOString();

/** Whether the desk has the answer of decision `d` queued for its registered agent (one read, no wait), else why not. */
function askerOf(d: Decision) {
  // Not answered: a `not sent:` outcome reopened the card, and the asker hears only once it really settles.
  if (!d.answer) {
    return { name: d.asker, told: "not_told" };
  }
  if (isSendDue(d) && !d.send) {
    return { name: d.asker, told: "not_yet", why: "the send has not ended" };
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
    (db) => eventHeard(db, agent, `${d.id}.answered`),
    "not_yet"
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
    agent,
    at: at(),
    name: d.asker,
    told: read.value,
    ...(read.value === "not_yet"
      ? { why: "the desk has not queued it yet" }
      : {}),
  };
}

/** The tap `key` made (the newest without a key): its answer, the outcome of its send, or the one that voided it. */
function tapOf(d: Decision, key?: string) {
  if (d.answer && (!key || d.answer.answerKey === key)) {
    return { answer: d.answer, notSent: undefined, send: d.send };
  }
  const v = key
    ? d.voided?.find((x) => x.answer.answerKey === key)
    : d.voided?.at(-1);
  return { answer: v?.answer, notSent: v?.notSent, send: undefined };
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
  return tap.answer && isSendDue(d) ? { state: "pending" } : null;
}

/** The answer's proof for a decision, composed from what is stored. */
async function decisionResult(ref: string, key?: string) {
  let d = decisionsNow().find((x) => x.id === ref) as Decision;
  // A repeat arrives while the first call's send still runs (a dropped stream): wait for its outcome, never send.
  const end = performance.now() + (d.draft ? sendLimitMs(d.draft) : 0);
  while (isSendDue(d) && !d.send && performance.now() < end) {
    // biome-ignore lint/performance/noAwaitInLoops: polling the decisions' lines
    await Bun.sleep(POLL_MS);
    d = decisionsNow().find((x) => x.id === ref) as Decision;
  }
  const tap = tapOf(d, key);
  return {
    asker: askerOf(d),
    changed: {
      decision: ref,
      options: tap.answer?.options ?? [],
      state: d.state,
    },
    done: [tap.answer, tap.notSent ?? tap.send].filter(Boolean),
    kind: "decision",
    ref,
    send: sendResultOf(d, tap),
    start: null,
  };
}

const VOICE_ANSWER: Record<string, string> = {
  media: "media",
  "not-anyone-i-know": "not_anyone",
  "not-relevant": "not_relevant",
  "this-is": "named",
};

/** What each kind of check changed, from the check and his answer. */
function changedOf(c: Check, a: CheckAnswer, done: unknown[]) {
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
    person: a.person ?? c.ref,
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

/** The steps an answer will report, in order: a decision's (and its send's), a new matter's Start (the desk's start stages), else Life's guesses'. */
function planOf(
  known: Decision | undefined,
  sends: boolean | undefined,
  starts: boolean
) {
  if (known) {
    return [
      "recorded",
      ...(sends && known.draft ? sendStepsOf(known.draft) : []),
    ];
  }
  return starts ? ["goal_saved", ...START_STAGES, "recorded"] : ["recorded"];
}

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
  const tapKey = `${ref}|${saidOf(a)}`;
  const failedKey = `${ref}|${answerKey}`;
  const remembered =
    rememberedTap(tapKey) ?? (answerKey ? rememberedTap(failedKey) : undefined);
  if (remembered) {
    return remembered;
  }
  const open = await openCheckOf(ref);
  const sends = known?.state === "open" && sendsOn(known, a.options, a.note);
  const starts = open.group === "new matter" && a.options[0] === "start";
  report({
    limitSeconds: Math.ceil(
      ((sends && known.draft ? sendLimitMs(known.draft) : 0) +
        (starts ? WAIT_MS : 0) +
        QUICK_MS) /
        1000
    ),
    plan: planOf(known, sends, starts),
  });
  // A new matter's Start: the desk's start, as `change_registered_agent` asks it; its own plan is in this one.
  let start: Awaited<ReturnType<typeof changeRegisteredAgent>> | null = null;
  const startAgent: StartAgent = async (c, goal) => {
    start = await changeRegisteredAgent(
      { action: "start", said: goal, step: c.ref },
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
    answerKey,
    onStep: (step, detail) => report({ at: at(), step, ...detail }),
    startAgent,
  });
  if (check.group === "decision") {
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
