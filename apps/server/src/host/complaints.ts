import { clock } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { off } from "../core/outputs";
import { stageOf } from "../memory/complaint-record";
import type { Complaint } from "../records/ledger-entry";
import { ask } from "./asks";
import { WAIT_MS } from "./change-registered-agent";
import { complaintReceiptOf, readDesk } from "./desk-read";
import { openChecksNow } from "./inbox";

// His complaint: his words through Ask Life (the main session's `complain`), one ask of the desk in the ledger per
// ask key; then this waits for the desk to receive it for the caretaker, which writes its complaint record row first and
// its receipt (its event row, `complaintReceiptOf`) after. Only then does the main session hear `reached: "caretaker"`.

const POLL_MS = 500;

/** Waits for the desk's receipt of complaint `id`: `reached` once received, else a refusal that names why. */
async function reached(id: string, limitMs: number) {
  for (let waited = 0; ; waited += POLL_MS) {
    const r = readDesk((db) => complaintReceiptOf(db, id), null);
    if (r.state === "ok" && r.value) {
      return { ask: id, reached: "caretaker" };
    }
    if (waited >= limitMs) {
      const why = {
        off: "the desk is off",
        ok: `the desk has not received it in ${limitMs / 1000} s`,
        unreadable: r.state === "unreadable" ? r.why : "",
      }[r.state];
      throw new Error(
        `Not done: ${why}. His words are recorded: the caretaker gets them once it can start; a new complaint tries again.`
      );
    }
    // biome-ignore lint/performance/noAwaitInLoops: polls the desk's receipt
    await Bun.sleep(POLL_MS);
  }
}

/**
 * His complaint through Ask Life (the main session's `complain`, his words `said` found in his ask): on card `ref` when
 * one was on his screen (read now: null when it left; its cause Life's own, so it shows as being fixed), else on nothing
 * but his words; one per ask `key` (a second call under it is the first). `report`: he asked for the anonymized report to the developer. `{ ask, reached }` once the
 * desk received it for the caretaker.
 */
export async function complainThroughAskLife(
  said: string,
  ref: string | undefined,
  report: boolean,
  key: string,
  limitMs = WAIT_MS
) {
  const why = off("desk");
  if (why) {
    throw new Error(`Not done: ${why}`);
  }
  const card = ref
    ? ((await openChecksNow()).find((c) => c.ref === ref) ?? null)
    : null;
  const asked = ask(
    { at: clock().toISOString(), quote: said, ref: `complaint:${key}` },
    {
      agent: DESK_AGENT,
      complaint: {
        card,
        // The card's own cause as Life reads it now, so it shows as being fixed; none on his words alone.
        ...(card?.misread ? { cause: card.misread.cause } : {}),
        ...stageOf(card),
        ref: ref ?? "",
        report,
      } satisfies Complaint,
    },
    "connector",
    "his word through Tell Life that Life got something wrong"
  );
  return await reached(asked.id, limitMs);
}
