import { randomBytes } from "node:crypto";
import { z } from "zod";
import { clock } from "../core/clock";
import { matcherOf } from "../host/events";
import { Ask, decisionsNow, requestDecision } from "../memory/decisions";
import { readPeople } from "../memory/who";
import { waitOf } from "./agent-wait";
import {
  agentOf,
  type Desk,
  isFull,
  openTurn,
  queuedEvents,
  writeWait,
} from "./desk-store";

// What a registered agent does at the desk (the door's tools, `desk-door.ts`, which checks it is active) and how one is
// registered. Each writes its row
// at once; a desk turn running notes that it was heard from (`heard_at`) and how it will end.

const NOTES_MAX = 6000;
/** Who asks his decisions for a registered agent (each stamped with the agent's id). */
export const DESK_ASKER = "desk";

/** The decision `id` asked him that is still open, if any: one at a time, worked out from his decisions, never stored here. */
const openDecisionOf = (id: string) =>
  decisionsNow().find((d) => d.agent === id && d.state === "open")?.id ?? null;

/** Registers an agent on his words: active, its first turn due now. Refused while the desk keeps its most agents. */
export function register(
  { db }: Desk,
  a: { brief: string; folder: string; runtime: string }
) {
  if (isFull(db)) {
    throw new Error("Not done: the desk keeps 50 agents active at most.");
  }
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
  const open = openDecisionOf(id);
  if (open) {
    await requestDecision(DESK_ASKER, {
      agent: id,
      why: "its agent finished",
      withdraw: open,
    });
  }
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
 * What an agent gives `request_decision` at the door: an `Ask` less the desk's stamp, or a withdrawal.
 * ponytail: the connector keeps the same shape private in `host/http/mcp.ts` (`RequestDecisionArgs`); step 4 exports one.
 */
export const DoorAsk = Ask.omit({ agent: true })
  .partial()
  .extend({
    why: Ask.shape.why,
    withdraw: z
      .string()
      .optional()
      .describe("A decision id you asked, to withdraw it (with `why`)"),
  });

/**
 * `request_decision`: asks him as the desk, stamped with the agent's id and its session's link first; or withdraws its
 * own decision. `requestDecision` checks the rest, one open decision per agent included.
 */
export function askDecision(
  desk: Desk,
  id: string,
  { withdraw, why, ...ask }: z.infer<typeof DoorAsk>
) {
  heard(desk, id);
  if (withdraw) {
    return requestDecision(DESK_ASKER, { agent: id, why, withdraw });
  }
  const link = agentOf(desk.db, id)?.link;
  return requestDecision(DESK_ASKER, {
    ...ask,
    agent: id,
    links: [...(link ? [link] : []), ...(ask.links ?? [])],
    why,
  });
}

/** What every session of a registered agent is told after its brief (the desk spec, 5.4): the door's contract, no rule on its work. */
const contractOf = (id: string) =>
  `You are ${id}, a registered agent of the owner's desk. Your door (the \`desk\` MCP server) has your tools: call \`read_packet\` when you start; before you stop, call \`set_wait\` (what you wait for, until when) or \`finish\`; ask him only through \`request_decision\`, one at a time, with options and a recommendation; write your notes (\`write_notes\`) before you stop. His own rules apply as in any session of his.`;

/** `read_packet`: what a fresh session starts from: the brief, its notes, its queued events (facts only), its open decision. */
export function readPacket({ db }: Desk, id: string) {
  const a = agentOf(db, id);
  if (!a) {
    return "";
  }
  const events = queuedEvents(db, id).map((e) => e.payload);
  return [
    a.brief,
    contractOf(a.id),
    `Your notes:\n${a.notes || "(none yet)"}`,
    `Events waiting:\n${events.join("\n") || "(none)"}`,
    `Your open decision: ${openDecisionOf(id) ?? "none"}`,
  ].join("\n\n");
}
