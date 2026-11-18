import { randomBytes } from "node:crypto";
import type { z } from "zod";
import { clock } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import {
  agentOf,
  anchorsOf,
  isFull,
  openTurn,
  queuedEvents,
} from "../host/desk-read";
import { matcherOf } from "../host/events";
import {
  type DecisionRequest,
  decisionsNow,
  requestDecision,
} from "../memory/decisions";
import { readPeople } from "../memory/who";
import { waitOf } from "./agent-wait";
import { type Desk, writeWait } from "./desk-store";

// What a registered agent does at the desk (the door's tools, `desk-door.ts`, which checks it is active) and how one is
// registered. Each writes its row
// at once; a desk turn running notes that it was heard from (`heard_at`) and how it will end.

const NOTES_MAX = 6000;

/** The decision `id` asked him that is still open, if any: one at a time, worked out from his decisions, never stored here. */
const openDecisionOf = (id: string) =>
  decisionsNow().find((d) => d.agent === id && d.state === "open")?.id ?? null;

/** Writes an agent's subject: its anchors (a matter's steps, in order) or its project, replacing the old one. */
export function writeSubject(
  { db }: Desk,
  id: string,
  s: { project?: string; steps?: string[] }
) {
  const now = clock().toISOString();
  db.run("delete from anchor where agent_id = ?", [id]);
  for (const step of s.steps ?? []) {
    db.run(
      "insert or ignore into anchor (agent_id, step, added_at) values (?, ?, ?)",
      [id, step, now]
    );
  }
  db.run("update agent set project = ? where id = ?", [s.project ?? null, id]);
}

/** Registers an agent on his words: active, its first turn due now. Refused while the desk keeps its most agents. */
export function register(
  desk: Desk,
  a: {
    brief: string;
    effort?: string;
    folder: string;
    model?: string;
    project?: string;
    runtime: string;
    steps?: string[];
  }
) {
  const { db } = desk;
  if (isFull(db)) {
    throw new Error("Not done: the desk keeps 50 agents active at most.");
  }
  const id = `agt_${randomBytes(6).toString("hex")}`;
  const now = clock().toISOString();
  db.transaction(() => {
    db.run(
      "insert into agent (id, brief, runtime, folder, model, effort, status, wait_until, wait_reason, created_at) values (?, ?, ?, ?, ?, ?, 'active', ?, 'first turn', ?)",
      [
        id,
        a.brief,
        a.runtime,
        a.folder,
        a.model ?? null,
        a.effort ?? null,
        now,
        now,
      ]
    );
    writeSubject(desk, id, a);
  })();
  return id;
}

/** Withdraws agent `id`'s open decision, if any (the desk asked it, as `desk`): it finished or stopped, so no answer could reach it. */
export async function withdrawOpenDecision(id: string, why: string) {
  const open = openDecisionOf(id);
  if (open) {
    await requestDecision(DESK_AGENT, { agent: id, why, withdraw: open });
  }
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

/** `set_wait`: the agent's new wait, or why it is refused (the old wait then stands): a filter's person must be someone Life knows. */
export async function setWait(desk: Desk, id: string, input: unknown) {
  const r = waitOf(input, clock().getTime());
  const { wait } = r;
  if (!wait) {
    return r;
  }
  const people = await readPeople();
  const unknown = wait.events.find((f) => !matcherOf(f, people));
  if (unknown) {
    return { error: `No one goes by ${unknown.person}` };
  }
  desk.db.transaction(() => {
    writeWait(desk.db, id, wait, false);
    heard(desk, id, "waited");
  })();
  return r;
}

/** `finish`: the agent is ended with its outcome, and its open decision withdrawn (the desk asked it, as `desk`). */
export async function finish(desk: Desk, id: string, outcome: string) {
  desk.db.transaction(() => {
    desk.db.run(
      "update agent set status = 'ended', ended_at = ?, outcome = ? where id = ?",
      [clock().toISOString(), outcome, id]
    );
    heard(desk, id, "finished");
  })();
  await withdrawOpenDecision(id, "its agent finished");
}

/** `write_notes`: replaces the agent's notes, which open its next packet. */
export function writeNotes(desk: Desk, id: string, text: string) {
  desk.db.run("update agent set notes = ? where id = ?", [
    text.slice(0, NOTES_MAX),
    id,
  ]);
  heard(desk, id);
}

/**
 * `request_decision`: asks him as the desk, stamped with the agent's id and its session's link first; or withdraws its
 * own decision. `requestDecision` checks the rest, one open decision per agent included.
 */
export function askDecision(
  desk: Desk,
  id: string,
  { withdraw, why, ...ask }: z.infer<typeof DecisionRequest>
) {
  heard(desk, id);
  if (withdraw) {
    return requestDecision(DESK_AGENT, { agent: id, why, withdraw });
  }
  const link = agentOf(desk.db, id)?.link;
  return requestDecision(DESK_AGENT, {
    ...ask,
    agent: id,
    links: [...(link ? [link] : []), ...(ask.links ?? [])],
    why,
  });
}

/** What every session of a registered agent is told after its brief (the desk spec, 5.4): the door's contract, no rule on its work. */
const contractOf = (id: string) =>
  `You are ${id}, a registered agent of the owner's desk. Your door (the \`desk\` MCP server) has your tools: call \`read_packet\` when you start; before you stop, call \`set_wait\` (what you wait for, until when) or \`finish\`; ask him only through \`request_decision\`, one at a time, with options and a recommendation; write your notes (\`write_notes\`) before you stop. His own rules apply as in any session of his.`;

/** `read_packet`: what a fresh session starts from: the brief, its subject, its notes, its queued events (facts only), its open decision. */
export function readPacket({ db }: Desk, id: string) {
  const a = agentOf(db, id);
  if (!a) {
    return "";
  }
  const events = queuedEvents(db, id).map((e) => e.payload);
  const steps = anchorsOf(db, id);
  return [
    a.brief,
    contractOf(a.id),
    a.project
      ? `Your subject: the project ${a.project} (\`read_area_page\`).`
      : `Your subject: the matter holding ${steps.join(", ") || "(none)"} (\`read_matter\` with the first).`,
    `Your notes:\n${a.notes || "(none yet)"}`,
    `Events waiting:\n${events.join("\n") || "(none)"}`,
    `Your open decision: ${openDecisionOf(id) ?? "none"}`,
  ].join("\n\n");
}
