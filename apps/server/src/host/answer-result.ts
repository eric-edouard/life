import { clock } from "../core/clock";
import { answerCheck, type CheckAnswer } from "../memory/answer-check";
import { type Check, checksNow, inboxOf } from "../memory/checks";
import {
  type Decision,
  decisionsNow,
  isSendDue,
  notSentOf,
  sendsOn,
} from "../memory/decisions";
import type { StoredDraft } from "../memory/draft";
import { sendLimitMs, sendStepsOf } from "../memory/draft-send";
import { eventHeard, readDesk } from "./desk-read";
import type { ToolCall } from "./http/mcp-tool";

// His answer to a check, with proof (`answer_check`): what was written, what changed, what a send did, whether the
// asker was told, whether the card left. Nothing is stored here: each fact is read again from the store that owns it
// (the decisions' lines, the desk's event rows, `checksNow`), so this only composes them. Steps go out as they pass
// (`report`, `mcp-tool.ts`) after the plan: the steps to come and the most seconds they may take.

/** How long the asker's desk is given to queue the answer. */
const ASKER_WAIT_MS = 5000;
/** What an answer without a send is given in all: the asker's wait and the reads. */
const QUICK_MS = ASKER_WAIT_MS + 5000;
const POLL_MS = 500;

const at = () => clock().toISOString();

/** Whether the desk has the answer of decision `d` queued for its registered agent, else why not. */
async function askerOf(d: Decision) {
  // Not answered: a `not sent:` outcome reopened the card, and the asker hears only once it really settles.
  if (!d.answer) {
    return { name: d.asker, told: "not_told" };
  }
  if (isSendDue(d) && !d.send) {
    return { name: d.asker, told: "not_yet", why: "the send has not ended" };
  }
  const { agent } = d;
  if (!agent) {
    return { name: d.asker, told: "on_its_next_poll" };
  }
  const eventId = `${d.id}.answered`;
  const end = performance.now() + ASKER_WAIT_MS;
  for (;;) {
    const read = readDesk((db) => eventHeard(db, agent, eventId), "not_yet");
    if (read.state !== "ok") {
      return {
        agent,
        name: d.asker,
        told: "not_yet",
        why: read.state === "off" ? "the desk is off" : read.why,
      };
    }
    if (read.value !== "not_yet" || performance.now() > end) {
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
    // biome-ignore lint/performance/noAwaitInLoops: polling the desk's store
    await Bun.sleep(POLL_MS);
  }
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

/** The inbox after an answer: whether the card left, how many remain, how many are due today. */
async function inboxAfter(ref: string, report: ToolCall["report"]) {
  const list = await checksNow();
  const { deadlinesToday, total } = inboxOf(list);
  report({ at: at(), step: "left_inbox", total });
  return { deadlinesToday, left: !list.some((c) => c.ref === ref), total };
}

/** The answer's proof for a decision, composed from what is stored, and the inbox after. */
async function decisionResult(
  ref: string,
  report: ToolCall["report"],
  key?: string
) {
  let d = decisionsNow().find((x) => x.id === ref) as Decision;
  // A repeat arrives while the first call's send still runs (a dropped stream): wait for its outcome, never send.
  const end = performance.now() + (d.draft ? sendLimitMs(d.draft) : 0);
  while (isSendDue(d) && !d.send && performance.now() < end) {
    // biome-ignore lint/performance/noAwaitInLoops: polling the decisions' lines
    await Bun.sleep(POLL_MS);
    d = decisionsNow().find((x) => x.id === ref) as Decision;
  }
  const tap = tapOf(d, key);
  const asker = await askerOf(d);
  report({ at: at(), step: "asker_told", told: asker.told });
  return {
    asker,
    changed: {
      decision: ref,
      options: tap.answer?.options ?? [],
      state: d.state,
    },
    done: [tap.answer, tap.notSent ?? tap.send].filter(Boolean),
    inbox: await inboxAfter(ref, report),
    kind: "decision",
    ref,
    send: sendResultOf(d, tap),
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

async function answer(ref: string, a: CheckAnswer, call: ToolCall) {
  const { answerKey, report } = call;
  const known = decisionsNow().find((x) => x.id === ref);
  // The same tap again (his app's key on the answered line, or on one a `not sent:` voided): the stored result, nothing written.
  if (
    answerKey &&
    (known?.answer?.answerKey === answerKey ||
      known?.voided?.some((v) => v.answer.answerKey === answerKey))
  ) {
    return decisionResult(ref, report, answerKey);
  }
  const sends = known?.state === "open" && sendsOn(known, a.options, a.note);
  report({
    limitSeconds: Math.ceil(
      ((sends && known.draft ? sendLimitMs(known.draft) : 0) + QUICK_MS) / 1000
    ),
    plan: known
      ? [
          "recorded",
          ...(sends ? sendStepsOf(known.draft as StoredDraft) : []),
          "asker_told",
          "left_inbox",
        ]
      : ["recorded", "left_inbox"],
  });
  const { check, done, item } = await answerCheck(ref, a, "connector", {
    answerKey,
    onStep: (step, detail) => report({ at: at(), step, ...detail }),
  });
  if (check.group === "decision") {
    return decisionResult(ref, report, answerKey);
  }
  return {
    asker: { name: "life", told: "recorded" },
    changed: {
      ...changedOf(check, a, done),
      ...(item
        ? {
            conversations: new Set(item.voices.map((v) => v.jobId)).size,
            voices: item.voices.length,
          }
        : {}),
    },
    done,
    inbox: await inboxAfter(ref, report),
    kind: check.group,
    ref,
    send: null,
  };
}

/** The answers being recorded now, by check, with what each was given. */
const running = new Map<
  string,
  { call: ToolCall; result: Promise<Record<string, unknown>>; said: string }
>();

/**
 * Records his answer to the open check `ref` (`answerCheck`) and returns the proof: `done` (the lines written),
 * `changed`, `send`, `asker`, `inbox`. With the app's key for this tap (`call.answerKey`) a repeat of it returns the
 * stored result and writes and sends nothing. A second call on the same check while one runs gets that one's result,
 * unless it differs in both key and answer: then it is refused.
 */
export function answerWithResult(ref: string, a: CheckAnswer, call: ToolCall) {
  const said = JSON.stringify([a.options, a.note ?? null]);
  const first = running.get(ref);
  if (first) {
    if (first.call.answerKey !== call.answerKey && first.said !== said) {
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
