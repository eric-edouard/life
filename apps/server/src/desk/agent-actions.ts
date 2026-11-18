import { randomBytes } from "node:crypto";
import { clock } from "../core/clock";
import { waitOf } from "./agent-wait";
import {
  agentOf,
  type Desk,
  openTurn,
  queuedEvents,
  writeWait,
} from "./desk-store";

// What a registered agent does at the desk (the door's tools, step 3) and how one is registered. Each writes its row
// at once; a desk turn running notes that it was heard from (`heard_at`) and how it will end.

const NOTES_MAX = 6000;

/** Registers an agent on his words: active, its first turn due now. */
export function register(
  { db }: Desk,
  a: { brief: string; folder: string; runtime: string }
) {
  const id = `agt_${randomBytes(6).toString("hex")}`;
  const now = clock().toISOString();
  db.run(
    "insert into agent (id, brief, runtime, folder, status, wait_until, wait_reason, created_at) values (?, ?, ?, ?, 'active', ?, 'first turn', ?)",
    [id, a.brief, a.runtime, a.folder, now, now]
  );
  return id;
}

/** Marks the desk turn running for `id`, if any, as heard from now, and how it ends (`outcome`) when given. */
function heard({ db }: Desk, id: string, outcome?: "waited" | "finished") {
  const open = openTurn(db, id);
  if (open) {
    db.run(
      "update turn set heard_at = ?, outcome = coalesce(?, outcome) where id = ?",
      [clock().toISOString(), outcome ?? null, open.id]
    );
  }
}

/** `set_wait`: the agent's new wait, or why it is refused (the old wait then stands). */
export function setWait(desk: Desk, id: string, input: unknown) {
  if (agentOf(desk.db, id)?.status !== "active") {
    return { error: `${id} is not active` };
  }
  const r = waitOf(input, clock().getTime());
  const { wait } = r;
  if (wait) {
    desk.db.transaction(() => {
      writeWait(desk.db, id, wait, false);
      heard(desk, id, "waited");
    })();
  }
  return r;
}

/**
 * `finish`: the agent is ended with its outcome, its open decision withdrawn (its id returned: step 3 writes the
 * withdrawal to his decisions).
 */
export function finish(desk: Desk, id: string, outcome: string) {
  const a = agentOf(desk.db, id);
  desk.db.transaction(() => {
    desk.db.run(
      "update agent set status = 'ended', ended_at = ?, outcome = ?, open_decision = null where id = ?",
      [clock().toISOString(), outcome, id]
    );
    heard(desk, id, "finished");
  })();
  return { withdrawn: a?.open_decision ?? null };
}

/** `write_notes`: replaces the agent's notes, which open its next packet. */
export function writeNotes(desk: Desk, id: string, text: string) {
  desk.db.run("update agent set notes = ? where id = ?", [
    text.slice(0, NOTES_MAX),
    id,
  ]);
  heard(desk, id);
}

/** `read_packet`: what a fresh session starts from: the brief, its notes, its queued events (facts only), its open decision. */
export function readPacket({ db }: Desk, id: string) {
  const a = agentOf(db, id);
  if (!a) {
    return "";
  }
  const events = queuedEvents(db, id).map((e) => e.payload);
  return [
    a.brief,
    `You are ${a.id}. Your notes:\n${a.notes || "(none yet)"}`,
    `Events waiting:\n${events.join("\n") || "(none)"}`,
    `Your open decision: ${a.open_decision ?? "none"}`,
  ].join("\n\n");
}
