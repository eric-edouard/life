import { clock, unfrozen } from "../core/clock";
import { appendJsonl } from "../core/files";
import { SourceName } from "../core/names";
import { off } from "../core/outputs";
import {
  type Decision,
  decisionsNow,
  writeDecision,
} from "../memory/decisions";
import { LEDGER, readLedger } from "../memory/ledger";
import { sourceOf } from "../memory/sources";
import { LedgerEntry } from "../records/ledger-entry";
import { entryId } from "./act";

// Life's one send (docs/tasks.md, "Sends"): the exact text of the option he answered in a decision, into the chat its
// `ref` names (`<source>:<chat>`), through that source's `send`. Every check is here, so no caller decides it again.

/** Where a decision's reply goes: `ref` is `<source>:<chat>`, a source that can send. */
function chatOf(ref: string | undefined) {
  const at = ref?.indexOf(":") ?? -1;
  const source = SourceName.safeParse(ref?.slice(0, at));
  if (!(ref && source.success && at > 0)) {
    return;
  }
  const s = sourceOf(source.data);
  return s.send ? { chat: ref.slice(at + 1), s } : undefined;
}

/** Why this decision's reply may not go now, or null. `lines` are the send's own ledger lines, oldest first. */
export function sendRefusal(
  d: Decision | undefined,
  lines: LedgerEntry[],
  newer: () => boolean
) {
  if (!d) {
    return "no such decision";
  }
  if (d.status !== "answered") {
    return `${d.id} is ${d.status}, not answered`;
  }
  const draft = d.options.find((o) => o.id === d.answer)?.draft;
  if (!draft) {
    return "his answer carries no draft: nothing to send";
  }
  if (d.note) {
    return "he added a note: the text he approved changed, ask again";
  }
  if (!chatOf(d.ref)) {
    return `ref ${d.ref ?? "(none)"} is not <source>:<chat> of a source that sends`;
  }
  // Only a failed try may go again: one that never ended may have gone.
  const last = lines.at(-1);
  if (last && last.result !== "failed") {
    return last.result === "intent"
      ? "a send of it started and never ended: check the chat by hand"
      : "already sent";
  }
  return newer()
    ? "a message from them came after he answered: ask again"
    : null;
}

/** Sends the reply he chose in `decision` and closes it; throws why not. Returns the ledger's outcome line. */
export async function send(decision: string) {
  unfrozen("send a message");
  const no = off("sends");
  if (no) {
    throw new Error(no);
  }
  const d = decisionsNow().get(decision);
  const id = entryId(`decision:${decision}`, "sent", "");
  const lines = readLedger().filter((l) => l.id === id);
  const to = chatOf(d?.ref);
  const why = sendRefusal(d, lines, () =>
    // Anything of theirs in that chat since he was asked; read through the source itself, as every reader does.
    Boolean(
      d &&
        to?.s.kind === "chat" &&
        to.s
          .read(new Date(d.createdAt))
          .some((e) => e.chat === to.chat && !e.fromMe)
    )
  );
  if (why || !(d && to)) {
    throw new Error(why ?? "no such decision");
  }
  const text = d.options.find((o) => o.id === d.answer)?.draft as string;
  const line = (
    result: LedgerEntry["result"],
    error?: string
  ): LedgerEntry => ({
    after: { chat: to.chat, source: to.s.name },
    at: clock().toISOString(),
    id,
    instruction: {
      at: d.answeredAt as string,
      quote: `${d.question} → ${d.options.find((o) => o.id === d.answer)?.label}`,
      ref: `decision:${decision}`,
    },
    kind: "sent",
    result,
    schemaVersion: 1,
    target: decision,
    via: "session",
    why: "the reply he chose",
    ...(error ? { error } : {}),
  });
  appendJsonl(LEDGER, LedgerEntry, [line("intent")]);
  let done: LedgerEntry;
  try {
    await to.s.send?.(to.chat, text, id);
    done = line("ok");
  } catch (e) {
    done = line("failed", (e as Error).message);
  }
  appendJsonl(LEDGER, LedgerEntry, [done]);
  if (done.result === "ok") {
    writeDecision([
      { decision, step: "taken" },
      { data: { result: "sent" }, decision, step: "done" },
    ]);
  }
  return done;
}
