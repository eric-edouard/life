import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import { clock } from "../core/clock";
import { log } from "../core/log";
import { AGENT_POST_SIGNATURE, DESK_AGENT } from "../core/names";
import { DESK_AGENT_FOLDERS } from "../core/paths";
import { settings } from "../core/settings";
import {
  agentKindOf,
  agentOf,
  anchorsOf,
  isFull,
  openTurn,
  queuedEvents,
} from "../host/desk-read";
import { EVENT_CHANNELS, type EventChannel } from "../host/event-channels";
import { matcherOf, waitChannelsOf } from "../host/events";
import {
  type DecisionRequest,
  decisionsNow,
  openDecisionOf,
  requestDecision,
} from "../memory/decisions";
import { oneMatter } from "../memory/read-matters";
import { projectPeopleAndChatsOf } from "../memory/read-truth";
import { nameRefusalOf, readPeople } from "../memory/who";
import type { AgentKind, EventFilter } from "../records/registered-agent";
import { eventLineOf, waitOf } from "./agent-wait";
import { type Desk, writeWait } from "./desk-store";

// What a registered agent does at the desk (the door's tools, `desk-door.ts`, which checks it is active) and how one is
// registered. Each writes its row
// at once; a desk turn running notes that it was heard from (`heard_at`) and how it will end.

const NOTES_MAX = 6000;

/** Why the door refuses `set_wait` and `finish` until `id` has asked: its first card is its plan, or, when the desk started it, what it found. */
export const askFirstMessageOf = (kind: AgentKind) =>
  kind === "handed_out"
    ? "Not done: ask your card first (`request_decision`: the prepared step, what only he can do, or that it looks over; one option is Tell the agent…)."
    : "Not done: ask your plan first (`request_decision`: a question ending in a ?, options Go, Tell the agent…, Stop the agent).";

/** Whether agent `id` has asked him anything it did not withdraw: its first ask is its plan, so the door lets it wait or finish only after. */
export const hasAsked = (id: string) =>
  decisionsNow().some((d) => d.agent === id && d.state !== "withdrawn");

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

/**
 * Registers an agent, on his words or the hand-out's (`kind`, his by default): active, its first turn due now, in
 * `folder`, else in a folder of its own (`DESK_AGENT_FOLDERS`). Refused while the desk keeps its most agents.
 */
export function register(
  desk: Desk,
  a: {
    brief: string;
    effort?: string;
    folder?: string;
    kind?: AgentKind;
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
  const folder = a.folder ?? join(DESK_AGENT_FOLDERS, id);
  db.transaction(() => {
    db.run(
      "insert into agent (id, brief, runtime, folder, model, effort, status, wait_until, wait_reason, created_at, is_handed_out) values (?, ?, ?, ?, ?, ?, 'active', ?, 'first turn', ?, ?)",
      [
        id,
        a.brief,
        a.runtime,
        folder,
        a.model ?? null,
        a.effort ?? null,
        now,
        now,
        a.kind === "handed_out" ? 1 : 0,
      ]
    );
    writeSubject(desk, id, a);
  })();
  mkdirSync(folder, { recursive: true });
  return id;
}

/** Withdraws agent `id`'s open decision, if any (the desk asked it, as `desk`): it finished or stopped, so no answer could reach it. */
export async function withdrawOpenDecision(id: string, why: string) {
  const open = openDecisionOf(id);
  if (open) {
    await requestDecision(DESK_AGENT, { agent: id, why, withdraw: open.id });
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

/** Why filter `f`'s place cannot be matched, or null: one coordinate alone, a radius alone, or coordinates on channels whose events hold no point. */
function placeRefusalOf(
  f: EventFilter,
  named: string[],
  channels: EventChannel[]
) {
  if ((f.latitude === undefined) !== (f.longitude === undefined)) {
    return "`latitude` and `longitude` go together";
  }
  if (f.latitude === undefined) {
    return f.radius_m === undefined
      ? null
      : "`radius_m` needs `latitude` and `longitude`";
  }
  return channels.some((c) => named.includes(c.name) && c.hasPoint)
    ? null
    : `no channel named holds a place: coordinates need ${channels
        .filter((c) => c.hasPoint)
        .map((c) => `\`${c.name}\``)
        .join(" or ")}`;
}

/** Why a wait may not hold filter `f`, or null: a channel unknown, off or unreadable, or keys its channels cannot answer (a message's on event channels only, a quantity or a place none of them holds). */
function filterRefusalOf(
  f: EventFilter,
  { known, on }: { known: string[]; on: string[] },
  channels: EventChannel[]
) {
  const named = f.channels ?? [];
  const unknown = named.find((n) => !known.includes(n));
  if (unknown) {
    return `${unknown} is not a channel; channels: ${known.join(", ")}`;
  }
  const off = named.find((n) => !on.includes(n));
  if (off) {
    return channels.find((c) => c.name === off)?.block() ?? `${off} is off`;
  }
  if (
    named.length > 0 &&
    named.every((n) => channels.some((c) => c.name === n)) &&
    (f.person || f.chat || f.from_me)
  ) {
    return "`person`, `chat` and `from_me` are a message's: a filter on event channels only takes `text_matches`, `quantity` and a place";
  }
  const place = placeRefusalOf(f, named, channels);
  if (place) {
    return place;
  }
  if (!f.quantity) {
    return f.above === undefined && f.below === undefined
      ? null
      : "`above` and `below` need a `quantity`";
  }
  if (!f.channels) {
    return "`quantity` needs `channels`";
  }
  const { quantity } = f;
  if (
    !channels.some(
      (c) => named.includes(c.name) && c.quantities.includes(quantity)
    )
  ) {
    return `no channel named holds ${quantity}`;
  }
  return null;
}

/**
 * `set_wait`: the agent's new wait, or why it is refused (the old wait then stands): a channel unknown, off or that
 * cannot be read, keys a filter's channels cannot answer, or a person who is no one Life knows.
 */
export async function setWait(desk: Desk, id: string, input: unknown) {
  const r = waitOf(input, clock().getTime());
  const { wait } = r;
  if (!wait) {
    return r;
  }
  const channels = desk.channels ?? EVENT_CHANNELS;
  const lists = waitChannelsOf(desk.sources, channels);
  for (const f of wait.events) {
    const refusal = filterRefusalOf(f, lists, channels);
    if (refusal) {
      return { error: refusal };
    }
  }
  const people = await readPeople();
  const unknown = wait.events.find((f) => !matcherOf(f, people));
  if (unknown) {
    return { error: nameRefusalOf(unknown.person ?? "", people) };
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
      "update agent set status = 'ended', ended_at = ?, outcome = ? where id = ? and status = 'active'",
      [clock().toISOString(), outcome, id]
    );
    heard(desk, id, "finished");
  })();
  await withdrawOpenDecision(id, "its agent finished");
}

/** Stops the desk's own run of agent `id`'s open turn (`turn`, read before whatever closes it), if it has one (`Runtime.stop`): every end, and his stop. A failure is logged. */
export async function stopOpenRun(
  desk: Desk,
  id: string,
  turn = openTurn(desk.db, id)
) {
  if (!turn?.session) {
    return;
  }
  await desk.runtimes[agentOf(desk.db, id)?.runtime ?? ""]
    ?.stop(turn.session)
    .catch((error: unknown) =>
      log("desk.runtime", {
        agent: id,
        error: String(error),
        ok: false,
        what: "stop",
      })
    );
}

/** Ends agent `id` as `finish` does, then stops the run of its open turn, if any: the one way the tick ends an agent. */
export async function endAgent(desk: Desk, id: string, outcome: string) {
  const open = openTurn(desk.db, id);
  await finish(desk, id, outcome);
  await stopOpenRun(desk, id, open);
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
  });
}

/** The one sentence of the contract that differs: what a first turn does when he asked for the agent (his plan, then his Go). */
const PLAN_FIRST_TURN =
  ' Your first turn only reads and asks your plan (a question ending in a ?, such as "Start with this plan?", options Go, Tell the agent…, Stop the agent): act only after his Go.';

/** ... and when the desk started it itself (`hand-out.ts`): no plan card, one card of what it found. */
const HANDED_OUT_FIRST_TURN =
  ' Life handed you this matter from the top of his list; he did not ask for it. Your first turn reads and gathers (his chats, mail, files, the web), then asks ONE card, whichever is true: the next step prepared (a draft he can send as it is, in the channel the talk is already in, never mail when they talk in a chat); what only he can do (the step in a few words and every fact he needs for it: amount, account, address, phone, reference); or that it looks over (what shows it). Open the card\'s context with what you could not verify. Every card has an option for his own words (Tell the agent…). On a card for what only he can do, or that it looks over, mark the option that means done `ends: "step"` (the step as `subject`) or `ends: "matter"` (nothing is left): his pick closes it in Life. Every card also offers Drop it, marked `ends: "matter"`, for a matter he does not care about: his pick of it alone closes the matter in Life (when the matter has no open step left, Life refuses it: leave it out and say in the context that he can tell you to stop). No other option closes anything. Then wait for his answer; finish when the step is done or nothing is left for you. In a project\'s folder you only read, unless a card he approved says otherwise.';

/** What an agent of his own Life is told of the send guard (`send-guard.ts`), and of the repos it may post to itself. */
function sendGuardLines() {
  const repos = settings().desk?.agentPostRepos ?? [];
  return ` Life's send guard refuses any message, mail, invitation to others or messaging site or app that is not a card's draft, and says why.${repos.length > 0 ? ` One exception: on ${repos.join(", ")} you may comment, open an issue or review yourself with \`gh\` (its \`--repo\` named, the body given with \`--body\` and ending with this line: ${AGENT_POST_SIGNATURE}). People read it there in his name without his yes on the text: post only facts and questions; anything that commits him (a price, money, a date, a promise, a client) goes on a card.` : ""}`;
}

/** What every session of a registered agent is told after its brief (the desk spec, 5.4): the door's contract and his one gate (what waits on his yes, a plan before any act). */
const contractOf = (id: string, isOwn: boolean, kind: AgentKind) =>
  `You are ${id}, a registered agent of the owner's desk${isOwn ? ": one of his own sessions, in full" : ""}. Your door (the \`desk\` MCP server) has your tools: call \`read_packet\` when you start; before you stop, write your notes (\`write_notes\`) and call \`set_wait\` (what you wait for, until when) or \`finish\`. His own rules apply as in any session of his. ${isOwn ? "Free, never ask: this Mac is yours for the job. Read and search any file, his mail and his messages; browse and search the web; run commands; install what you need; use every tool, connector, CLI and key his sessions have, his 1Password included." : "You have your door's tools only."} The one gate: anything that acts outward in his name (a message or mail to anyone but him, a post, a payment, a booking, an acceptance, changing or deleting something outside this Mac that others see) happens only on his yes to that exact thing, asked through \`request_decision\`, one at a time; a message goes as the card's draft, which Life sends on his yes. Nothing else is gated.${isOwn ? `${sendGuardLines()} Reaching him: a decision is a card; something worth knowing while he is away may be mailed to him as his rules say (mail to him is not outward).` : ""}${kind === "handed_out" ? HANDED_OUT_FIRST_TURN : PLAN_FIRST_TURN} A \`call.ended\` event is a call of his that ended, with the recording his pendant made of it. Read each of its \`recordings\` with \`fetch\` (\`id\` its \`turn\`, which opens the recording from that turn as it is now; \`limit\` its \`turns\`, and read on if lines before \`until\` remain) and keep only the lines timed from \`at\` to \`until\`: the recording began before the call and went on after it, and nothing said outside those instants is the call's or may be quoted or sent. \`people\` is who may have been on it, not who spoke when: someone may have joined late. Voices heard through a speaker are often unnamed or merged into one: write such a line as an unnamed remote voice, never under a name the recording does not give. A \`payment.booked\` event is a payment his money app holds; its merchant and note are not in the wake. A \`stay.arrived\` event is an arrival at a place; its name is not in the wake, and one real arrival may wake you more than once (the same place, minutes apart: act once).`;

const NONE =
  "(none in his directory: find them with `read_chats` and `read_person_page`, and tell him who or which chat is missing)";

/** A project agent's subject: the project, then its people and chats as his directory holds them (what a wait's `person` and `chat` take). */
async function projectLinesOf(project: string) {
  const line = `Your subject: the project ${project} (\`read_area_page\`). A matter of it that has its own agent is that agent's to draft on.`;
  const held = projectPeopleAndChatsOf((await readPeople()).truth, project);
  if (!held) {
    return line;
  }
  const people = held.people.map(
    (p) =>
      `- ${p.id}: ${p.name}${p.aliases.length ? ` (also: ${p.aliases.join(", ")})` : ""}${p.handles.map((h) => `; ${h.platform} ${h.values.join(", ")}`).join("")}`
  );
  const chats = held.chats.map(
    (c) =>
      `- ${c.key}: ${c.name}${c.isSure ? "" : " (a room id he wrote down: check it against `read_chats` before you wait on it)"}`
  );
  return [
    line,
    "Its people, as his directory holds them (a wait's `person` takes the id):",
    ...(people.length ? people : [NONE]),
    "Its chats (a wait's `chat` takes the key):",
    ...(chats.length ? chats : [NONE]),
  ].join("\n");
}

/**
 * `read_packet`: what a fresh session starts from: its matter as read now (`oneMatter`: where it stands, its goal and
 * next step, its steps so far), or its project; then the brief, the contract, its notes, its queued events (facts only)
 * and its open decision.
 */
export async function readPacket({ db }: Desk, id: string, isOwn: boolean) {
  const a = agentOf(db, id);
  if (!a) {
    return "";
  }
  const events = queuedEvents(db, id).map(eventLineOf);
  const steps = anchorsOf(db, id);
  return [
    a.project
      ? await projectLinesOf(a.project)
      : `Your subject, the matter as read now (\`read_matter\` with ${steps[0] ?? "its step"} reads it again):\n${JSON.stringify((await oneMatter(steps)) ?? `No matter holds ${steps.join(", ")} now.`)}`,
    a.brief,
    contractOf(a.id, isOwn, agentKindOf(a)),
    `Your notes:\n${a.notes || "(none yet)"}`,
    `Events waiting:\n${events.join("\n") || "(none)"}`,
    `Your open decision: ${openDecisionOf(id)?.id ?? "none"}`,
  ].join("\n\n");
}
