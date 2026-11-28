import { z } from "zod";
import { clock } from "../core/clock";
import { appendJsonl } from "../core/files";
import { sendOf } from "./decision-fold";
import {
  DECISIONS,
  DECISIONS_VERSION,
  type Decision,
  SendFailed,
  Sent,
} from "./decision-lines";
import type { StoredDraft } from "./draft";
import type { sendDraft } from "./draft-send";

// The send of a decision's drafts on his answer (`answerDecision`, which hands it `sendDraft`, the one send): each draft
// in order, through the same send with every check of its own, one `sent` or `send-failed` line each (a batch's past the
// first with its `draftIndex`: the owner's decision of 28 Nov 2026). Nothing here sends twice: a draft with a line is
// never sent again, and only a card whose every draft ended `not sent:` is open again (`decision-fold.ts`).

type Send = Decision["sends"][number];
type OnStep = (step: string, detail?: Record<string, unknown>) => void;

/** Where draft `i`'s line says it belongs: the first draft's says nothing, as every line before batches. */
const draftIndexOf = (i: number) => (i > 0 ? { draftIndex: i } : {});

/** "Someone wrote since" counts from his last attempt that went nowhere, else from the card. */
export const sinceOf = (d: Pick<Decision, "at" | "notSent">) =>
  new Date(d.notSent?.at ?? d.at);

/** `d`'s send lines once its send never ended (a crash): each draft with none may have gone, so nothing is sent twice. */
export const sendsNeverEndedOf = (
  d: Pick<Decision, "drafts" | "id" | "sends">,
  at: string
): Send[] => [
  ...d.sends,
  ...d.drafts.flatMap((_, i): Send[] =>
    sendOf(d.sends, i)
      ? []
      : [
          {
            at,
            ...draftIndexOf(i),
            error:
              "may have gone: a send started and never ended: read the chat before asking again",
            id: d.id,
            kind: "send-failed" as const,
            schemaVersion: DECISIONS_VERSION,
          },
        ]
  ),
];

/** Sends each of the answered card `d`'s drafts in order, one at a time (`deliver`: `sendDraft`), each line as it ends. */
export async function sendOnAnswer(
  d: Omit<Decision, "state">,
  steps: { deliver: typeof sendDraft; onStep?: OnStep }
) {
  const sends: Send[] = [];
  for (const [i, draft] of d.drafts.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: a batch's drafts go one at a time, in order
    sends.push(await sendOne(draft, i, d, steps));
  }
  return sends;
}

/**
 * Sends draft `i` of `d` once and appends its outcome line. Its send id is the card's id, and `<id>.<i>` past the first
 * draft: a send path takes one message per id.
 */
async function sendOne(
  draft: StoredDraft,
  i: number,
  d: Omit<Decision, "state">,
  { deliver, onStep }: { deliver: typeof sendDraft; onStep?: OnStep }
) {
  const more = draftIndexOf(i);
  const outcome = await deliver(draft, i > 0 ? `${d.id}.${i}` : d.id, {
    onStep:
      i > 0 ? (step, detail) => onStep?.(step, { ...detail, ...more }) : onStep,
    since: sinceOf(d),
  }).then(
    (eventId) => ({ eventId, kind: "sent" as const }),
    (e: Error & { canRetry?: false; wrote?: SendFailed["wrote"] }) => ({
      error: e.message,
      kind: "send-failed" as const,
      ...(e.canRetry === false ? { canRetry: false as const } : {}),
      ...(e.wrote ? { wrote: e.wrote } : {}),
    })
  );
  const sent: Send = {
    at: clock().toISOString(),
    ...more,
    id: d.id,
    schemaVersion: DECISIONS_VERSION,
    ...outcome,
  };
  appendJsonl(DECISIONS, z.union([Sent, SendFailed]), [sent]);
  return sent;
}
