import { clock, DAY, unfrozen } from "../core/clock";
import { SourceName } from "../core/names";
import { off } from "../core/outputs";
import {
  type Decision,
  decisionsNow,
  writeDecision,
} from "../memory/decisions";
import { readLedger } from "../memory/ledger";
import { sourceOf } from "../memory/sources";
import { type LedgerEntry, stands } from "../records/ledger-entry";
import type { SourceEvent } from "../records/source";
import type { Descriptor } from "../sources/contract";
import { attempt, entryId } from "./act";

// Life's one send (docs/tasks.md, "The only sends"): the exact text of the option he answered in a decision, into the
// chat its `ref` names (`<source>:<chat>`), through that source's `send`. Every check is here, so no caller decides it
// again.

/** Where a decision's reply goes: `ref` is `<source>:<chat>` of a source that can send. */
export function chatOf(ref: string | undefined) {
  const at = ref?.indexOf(":") ?? -1;
  const name = SourceName.safeParse(ref?.slice(0, at));
  const s = name.success ? sourceOf(name.data) : undefined;
  return ref && at > 0 && s?.send
    ? { chat: ref.slice(at + 1), s, send: s.send }
    : undefined;
}

/**
 * Who a decision's reply would go to, as his card shows it (the source and the chat's name in its last week), so his
 * tap approves the recipient too; none when its `ref` names no chat a source can send to.
 */
export function recipientOf(ref: string | undefined) {
  const to = chatOf(ref);
  if (!to) {
    return;
  }
  const since = new Date(clock().getTime() - (to.s.chatDays ?? 7) * DAY);
  const name =
    to.s.kind === "chat"
      ? to.s.read(since).findLast((e) => e.chat === to.chat)?.chatName
      : undefined;
  return `${to.s.label} · ${name ?? to.chat}`;
}

/** Why a source can't send now, from the network itself (a status read waits 10 s at most); none when it can. */
export const sendBlockOf = (s: Descriptor) =>
  s.send
    ? withTimeout(s.send.blocked(), 10_000, "not answering in 10 s")
    : Promise.resolve("it doesn't send");

/** `p`, or `why` once `ms` pass. */
export const withTimeout = <T, W>(p: Promise<T>, ms: number, why: W) =>
  Promise.race<T | W>([p, Bun.sleep(ms).then(() => why)]);

/** Whether someone else wrote in `chat` among `events`. */
export const isNewerFrom = (events: SourceEvent[], chat: string) =>
  events.some((e) => e.chat === chat && !e.fromMe);

/** Why this decision's reply may not go now, or null. `lines` are the send's own ledger lines, oldest first. */
export function sendRefusal(
  d: Decision | undefined,
  lines: LedgerEntry[],
  newer: () => boolean
) {
  if (!d) {
    return "no such decision";
  }
  // Taken: the loop that asked took it first, as it takes every decision it acts on.
  if (!(d.status === "answered" || d.status === "taken")) {
    return `${d.id} is ${d.status}, not answered`;
  }
  if (!d.options.find((o) => o.id === d.answer)?.draft) {
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
    return stands(last)
      ? "already sent"
      : "a send of it started and never ended: check the chat by hand";
  }
  return newer()
    ? "a message from them came since it was asked: ask again"
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
  const to = chatOf(d?.ref);
  const why = sendRefusal(
    d,
    readLedger().filter((l) => l.id === id),
    // Read through the source itself, as every reader does: the archive's copy is at most one pass (5 s) behind.
    () =>
      Boolean(
        d &&
          to?.s.kind === "chat" &&
          isNewerFrom(to.s.read(new Date(d.createdAt)), to.chat)
      )
  );
  const option = d?.options.find((o) => o.id === d.answer);
  if (why || !(d && to && option?.draft && d.answeredAt)) {
    throw new Error(why ?? `${decision} is not answered`);
  }
  const { draft } = option;
  const done = await attempt(
    {
      after: { chat: to.chat, source: to.s.name },
      at: clock().toISOString(),
      id,
      instruction: {
        at: d.answeredAt,
        quote: `${d.question} → ${option.label}`,
        ref: `decision:${decision}`,
      },
      kind: "sent",
      result: "intent",
      schemaVersion: 1,
      target: decision,
      via: "session",
      why: "the reply he chose",
    },
    () => to.send.deliver(to.chat, draft, id).then(() => undefined)
  );
  if (done.result === "ok") {
    writeDecision([
      ...(d.status === "answered"
        ? [{ decision, step: "taken" as const }]
        : []),
      { data: { result: "sent" }, decision, step: "done" },
    ]);
  }
  return done;
}
