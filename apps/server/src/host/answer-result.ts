import { clock } from "../core/clock";
import {
  answerCheck,
  type CheckAnswer,
  readVoiceItem,
} from "../memory/answer-check";
import { type Check, checksNow, inboxOf } from "../memory/checks";
import {
  type Decision,
  decisionsNow,
  isSendDue,
  sendsOn,
} from "../memory/decisions";
import { sendLimitMs } from "../memory/draft-send";
import { enabledSources } from "../memory/sources";
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

/** The answers being recorded now, by check: a second call on the same check awaits the first. */
const inFlight = new Map<string, Promise<Record<string, unknown>>>();

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

/** What his answer's send did, as the app shows it: none when it sends nothing. */
function sendOf(d: Decision) {
  const channel = d.draft?.channel;
  const to = d.draft?.to;
  if (d.answer && d.send) {
    return d.send.kind === "sent"
      ? {
          at: d.send.at,
          channel,
          eventId: d.send.eventId,
          state: "sent",
          to,
        }
      : {
          at: d.send.at,
          canRetry: false,
          reason: d.send.error,
          state: "may_have_gone",
        };
  }
  if (!d.answer && d.notSent) {
    return {
      at: d.notSent.at,
      canRetry: d.notSent.retry !== false,
      reason: d.notSent.error,
      state: "not_sent",
    };
  }
  return null;
}

/** The lines this tap wrote, from the store: his answer and the send's outcome (a tap whose answer a `not sent:` voided too). */
function linesOf(d: Decision, key?: string) {
  const mine =
    d.answer && (!key || d.answer.answerKey === key)
      ? [d.answer, d.send]
      : [d.voided, d.notSent];
  return mine.filter(Boolean);
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
  const asker = await askerOf(d);
  report({ at: at(), step: "asker_told", told: asker.told });
  const list = await checksNow();
  const inbox = { left: !list.some((c) => c.ref === ref), ...inboxOf(list) };
  report({ at: at(), step: "left_inbox", total: inbox.total });
  return {
    asker,
    changed: {
      decision: ref,
      options: (d.answer ?? d.voided)?.options ?? [],
      state: d.state,
    },
    done: linesOf(d, key),
    inbox: {
      deadlinesToday: inbox.deadlinesToday,
      left: inbox.left,
      total: inbox.total,
    },
    kind: "decision",
    ref,
    send: sendOf(d),
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
  // The same tap again (his app's key on the answered line, or on the one a `not sent:` voided): the stored result, nothing written.
  if (
    answerKey &&
    (known?.answer?.answerKey === answerKey ||
      known?.voided?.answerKey === answerKey)
  ) {
    return decisionResult(ref, report, answerKey);
  }
  const check = (await checksNow()).find((c) => c.ref === ref);
  if (!check) {
    throw new Error(
      `Not done: no open check ${ref}; \`read_inbox\` lists them.`
    );
  }
  const sends = known && sendsOn(known, a.options, a.note);
  const mail =
    sends &&
    known.draft?.channel &&
    enabledSources().find((s) => s.name === known.draft?.channel)?.kind ===
      "mail";
  const voice =
    check.group === "voice" ? await readVoiceItem(check) : undefined;
  const plan =
    check.group === "decision"
      ? [
          "recorded",
          ...(sends
            ? [...(mail ? [] : ["chat_checked"]), "handed", "confirmed"]
            : []),
          "asker_told",
          "left_inbox",
        ]
      : ["recorded", "left_inbox"];
  report({
    limitSeconds: Math.ceil(
      ((sends && known.draft ? sendLimitMs(known.draft) : 0) + QUICK_MS) / 1000
    ),
    plan,
  });
  const { done } = await answerCheck(ref, a, "connector", {
    answerKey,
    onStep: (step, detail) => report({ at: at(), step, ...detail }),
  });
  if (check.group === "decision") {
    return decisionResult(ref, report, answerKey);
  }
  const list = await checksNow();
  const inbox = { ...inboxOf(list), left: !list.some((c) => c.ref === ref) };
  report({ at: at(), step: "left_inbox", total: inbox.total });
  return {
    asker: { name: "life", told: "recorded" },
    changed: {
      ...changedOf(check, a, done),
      ...(voice
        ? {
            conversations: new Set(voice.voices.map((v) => v.jobId)).size,
            voices: voice.voices.length,
          }
        : {}),
    },
    done,
    inbox: {
      deadlinesToday: inbox.deadlinesToday,
      left: inbox.left,
      total: inbox.total,
    },
    kind: check.group,
    ref,
    send: null,
  };
}

/**
 * Records his answer to the open check `ref` (`answerCheck`) and returns the proof: `done` (the lines written),
 * `changed`, `send`, `asker`, `inbox`. With the app's key for this tap (`call.answerKey`) a repeat of it returns the
 * stored result and writes and sends nothing; a second call on the same check while one runs gets that one's result.
 */
export function answerWithResult(ref: string, a: CheckAnswer, call: ToolCall) {
  const running = inFlight.get(ref);
  if (running) {
    return running;
  }
  const first = answer(ref, a, call).finally(() => inFlight.delete(ref));
  inFlight.set(ref, first);
  return first;
}
