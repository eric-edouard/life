import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { clock } from "../core/clock";
import { log } from "../core/log";
import { errorOf } from "../core/log-line";
import { AGENT_POST_SIGNATURE, DESK_AGENT } from "../core/names";
import { DESK_AGENT_FOLDERS } from "../core/paths";
import { pathInside } from "../core/platform";
import { commitPaths } from "../core/proc";
import { settings } from "../core/settings";
import {
  type AgentRow,
  type AssignmentRow,
  agentHomeOf,
  agentOf,
  agentWaitOf,
  anchorsOf,
  assignmentOf,
  assignmentOfCard,
  handedSteps,
  isFull,
  openTurn,
  queuedEvents,
  readNotes,
  siblingOn,
} from "../host/desk-read";
import { EVENT_CHANNELS, type EventChannel } from "../host/event-channels";
import { matcherOf, waitChannelsOf } from "../host/events";
import { opensWithPlan } from "../host/inbox";
import type { DecisionRequest } from "../memory/card-request";
import { communicationStylesOf } from "../memory/communication-styles";
import { decisionsNow, requestDecision } from "../memory/decisions";
import { isAsked, isPending } from "../memory/draft-contest";
import { oneMatter, readMatterProjectIds } from "../memory/read-matters";
import {
  loadTruth,
  PROJECT_NOTES_MAX,
  projectHeaderOf,
  projectPeopleAndChatsOf,
  type Truth,
} from "../memory/read-truth";
import { clip } from "../memory/units";
import { nameRefusalOf, readPeople } from "../memory/who";
import type {
  AgentRole,
  EventFilter,
  OpenedBy,
} from "../records/registered-agent";
import { eventLineOf, waitOf } from "./agent-wait";
import { cardHomeOf } from "./card-home";
import { closeAssignmentRow, type Desk, writeWait } from "./desk-store";

// What a registered agent does at the desk (the door's tools, `desk-door.ts`, which checks it is active) and how one is
// registered. Each writes its row
// at once; a desk turn running notes that it was heard from (`heard_at`) and how it will end.

/** A matter's record on a wake (`matterRecordOf`): its newest steps since the last turn, each step's text, and its notes, at most. */
const RECORD_STEPS = 8;
const RECORD_STEP_CHARS = 200;
const RECORD_NOTES_CHARS = 1500;

/** Why the door refuses `set_wait` and `finish` until its assignment has a card: its first card is its plan, or, when the desk opened it, what it found. */
export const askFirstMessageOf = (openedBy: OpenedBy) =>
  openedBy === "desk"
    ? "Not done: ask your card first (`request_decision`: the prepared step, what only he can do, or that it looks over)."
    : 'Not done: ask your plan first (`request_decision` with `plan`, options `start` and `decline`: fetch("ask/plan")).';

/** The cards of assignment `s.id`, else of every assignment agent `s.agent_id` holds (`assignmentOfCard`): a card folded with its assignment is its new agent's. */
function cardsOf(
  db: Desk["db"],
  s: { agent_id: string; id?: string },
  list: ReturnType<typeof decisionsNow>
) {
  const mine = new Set(
    s.id
      ? [s.id]
      : db
          .query<{ id: string }, [string]>(
            "select id from assignment where agent_id = ?"
          )
          .all(s.agent_id)
          .map((r) => r.id)
  );
  return list.filter((d) => mine.has(assignmentOfCard(db, d) ?? ""));
}

/** Assignment `s`'s card open or waiting on another (`isPending`), if any: one at a time. */
export const pendingCardOf = (
  db: Desk["db"],
  s: Pick<AssignmentRow, "agent_id" | "id">,
  list = decisionsNow()
) => cardsOf(db, s, list).find(isPending);

/** Whether assignment `s` has a card he was asked and not withdrawn (one another card took the place of counts): its first card is its plan, so the door lets its agent wait or finish only after. */
export const hasAsked = (
  db: Desk["db"],
  s: Pick<AssignmentRow, "agent_id" | "id">,
  list = decisionsNow()
) => cardsOf(db, s, list).some(isAsked);

/** Whether the card assignment `s` asks now is its plan card: one that opens with a plan (`opensWithPlan`), nothing asked yet (`hasAsked`), as `planCardsOf` reads it. */
const asksPlanOf = (db: Desk["db"], s: AssignmentRow) =>
  opensWithPlan(db, s) && !hasAsked(db, s);

/** Where a new assignment's notes file goes: in his agents repo (`desk.agentsRepo`), else under the desk's folders. */
const notesPathOf = (id: string) =>
  join(
    settings().desk?.agentsRepo ?? DESK_AGENT_FOLDERS,
    "assignments",
    id,
    "NOTES.md"
  );

/**
 * Writes assignment `assignment`'s subject, replacing the old one (his re-point): its anchors (a matter's steps, in
 * order), and its agent's project, or that it is the Personal agent. Nothing of the old subject counts as shown on the new (`handed_step`, a turn's
 * pending).
 */
export function writeSubject(
  { db }: Desk,
  agent: string,
  assignment: string,
  s: { matter?: string; project?: string; role?: "personal"; steps?: string[] }
) {
  const now = clock().toISOString();
  db.run("update assignment set matter_id = ? where id = ?", [
    s.matter ?? null,
    assignment,
  ]);
  db.run("delete from anchor where assignment_id = ?", [assignment]);
  db.run("delete from handed_step where assignment_id = ?", [assignment]);
  pendingOf(db).delete(assignment);
  for (const step of s.steps ?? []) {
    db.run(
      "insert or ignore into anchor (assignment_id, step, added_at) values (?, ?, ?)",
      [assignment, step, now]
    );
  }
  db.run("update agent set project = ?, role = ? where id = ?", [
    s.project ?? null,
    s.role ?? null,
    agent,
  ]);
}

/** Opens an assignment for agent `agent` on a matter's steps (none: its own) and the matter chosen (`matter`: its id), opened by him (`said`: his words, when he gave any) or the desk: its first turn due now. Its agent's project is its own (`register`, `writeSubject`). Its id. */
export function openAssignment(
  { db }: Desk,
  agent: string,
  a: { matter?: string; openedBy: OpenedBy; said?: string; steps?: string[] }
) {
  const id = `asg_${randomBytes(6).toString("hex")}`;
  const now = clock().toISOString();
  const { matter = null, openedBy, said = null } = a;
  // One write: an assignment is never open without its anchors.
  db.transaction(() => {
    db.run(
      "insert into assignment (id, agent_id, opened_at, opened_by, said, wait_until, wait_reason, notes_path, matter_id) values (?1, ?2, ?3, ?4, ?5, ?3, 'first turn', ?6, ?7)",
      [id, agent, now, openedBy, said, notesPathOf(id), matter]
    );
    for (const step of a.steps ?? []) {
      db.run(
        "insert or ignore into anchor (assignment_id, step, added_at) values (?, ?, ?)",
        [id, step, now]
      );
    }
  })();
  return id;
}

/** What the Personal agent's home holds until direction writes its rules (his word of 20 Nov 2026). */
const PERSONAL_RULES_PLACEHOLDER =
  "The rules of this agent are being written.\n";

/**
 * Registers an agent on his words, with its own assignment (`steps`: on a matter instead): active, its first turn due
 * now, in `folder`, else in a folder of its own (`DESK_AGENT_FOLDERS`), in its standing `role` when it has one (one
 * active or stopped of each: the store refuses a second). The Personal agent gets a placeholder `AGENTS.md` in its
 * folder when none is there. Refused while the desk keeps its most agents.
 */
export function register(
  desk: Desk,
  a: {
    brief: string;
    effort?: string;
    folder?: string;
    model?: string;
    name?: string;
    project?: string;
    role?: AgentRole;
    runtime: string;
    steps?: string[];
  }
) {
  const { db } = desk;
  if (isFull(db)) {
    throw new Error("Not done: the desk keeps 50 agents active at most.");
  }
  const id = `agt_${randomBytes(6).toString("hex")}`;
  const folder = a.folder ?? join(DESK_AGENT_FOLDERS, id);
  db.transaction(() => {
    db.run(
      "insert into agent (id, brief, runtime, folder, model, effort, project, name, role, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)",
      [
        id,
        a.brief,
        a.runtime,
        folder,
        a.model ?? null,
        a.effort ?? null,
        a.project ?? null,
        a.name ?? null,
        a.role ?? null,
        clock().toISOString(),
      ]
    );
    openAssignment(desk, id, { openedBy: "owner", steps: a.steps });
  })();
  mkdirSync(folder, { recursive: true });
  const rules = join(folder, "AGENTS.md");
  if (a.role === "personal" && !existsSync(rules)) {
    writeFileSync(rules, PERSONAL_RULES_PLACEHOLDER);
  }
  return id;
}

/** Withdraws the open cards of assignment `s`, or of every assignment of its agent when `s` names none (the desk asked them, as `desk`): it closed or its agent stopped, so no answer could reach them. */
export async function withdrawOpenCards(
  db: Desk["db"],
  s: { agent_id: string; id?: string },
  why: string
) {
  for (const d of cardsOf(db, s, decisionsNow())) {
    if (isPending(d)) {
      // As the agent that asked it, a folded card's included: the desk checked it is this assignment's.
      // biome-ignore lint/performance/noAwaitInLoops: one append at a time
      await requestDecision(DESK_AGENT, {
        agent: d.agent,
        why,
        withdraw: d.id,
      });
    }
  }
}

/** Marks the desk turn running on assignment `s`, if any, as heard from now, and how it ends (`outcome`) when given: a turn on another assignment of its agent is never touched. */
function heard(
  { db }: Desk,
  s: Pick<AssignmentRow, "agent_id" | "id">,
  outcome?: "waited" | "finished"
) {
  db.run(
    "update turn set heard_at = ?, outcome = coalesce(?, outcome) where agent_id = ? and assignment_id = ? and ended_at is null",
    [clock().toISOString(), outcome ?? null, s.agent_id, s.id]
  );
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

/** Whether `f` holds a key only a message answers. */
const hasMessageKeys = (f: EventFilter) =>
  Boolean(f.person || f.chat || f.from_me);

/** Why `f`'s `repo` cannot fire, or null: one with a quantity, a place or a message's key, one without a channel holding repos, or such a channel named without one. */
function repoRefusalOf(
  f: EventFilter,
  named: string[],
  channels: EventChannel[]
) {
  const withRepo = channels.filter((c) => c.hasRepo).map((c) => c.name);
  const names = withRepo.map((n) => `\`${n}\``).join(" or ");
  const namesOne = named.some((n) => withRepo.includes(n));
  if (f.repo && (f.quantity || f.latitude !== undefined || hasMessageKeys(f))) {
    return "a filter with a `repo` takes no `quantity`, place, `person`, `chat` or `from_me`: no event holds both";
  }
  if (f.repo && !namesOne) {
    return `\`repo\` needs \`channels\` naming ${names}`;
  }
  return !f.repo && namesOne
    ? `${names} needs a \`repo\`: \`owner/name\` or \`owner/*\``
    : null;
}

/** Why a wait may not hold filter `f`, or null: a channel unknown, off or unreadable, or keys its channels cannot answer (a message's on event channels only, a quantity, a place or a repo none of them holds), or a channel holding repos named without one. */
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
    hasMessageKeys(f)
  ) {
    return "`person`, `chat` and `from_me` are a message's: a filter on event channels only takes `text_matches`, `quantity`, a place and a `repo`";
  }
  const keys =
    placeRefusalOf(f, named, channels) ?? repoRefusalOf(f, named, channels);
  if (keys) {
    return keys;
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
 * `set_wait`: assignment `s`'s new wait, or why it is refused (the old wait then stands): a channel unknown, off or that
 * cannot be read, keys a filter's channels cannot answer, or a person who is no one Life knows.
 */
export async function setWait(desk: Desk, s: AssignmentRow, input: unknown) {
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
    writeWait(desk.db, s.id, wait, false);
    heard(desk, s, "waited");
  })();
  return r;
}

/** Closes assignment `s` with `outcome` (its agent ended when it has no other open), and withdraws its open card (the desk asked it, as `desk`). */
async function closeWithdrawing(
  desk: Desk,
  s: { agent_id: string; id: string },
  outcome: string
) {
  desk.db.transaction(() => {
    closeAssignmentRow(desk.db, s.id, { outcome });
    heard(desk, s, "finished");
  })();
  await withdrawOpenCards(desk.db, s, "its agent finished");
}

/** `finish`: assignment `s` is closed with its outcome; its turn ends by itself. */
export const finish = (desk: Desk, s: AssignmentRow, outcome: string) =>
  closeWithdrawing(desk, s, outcome);

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
        ...errorOf(error),
        ok: false,
        what: "stop",
      })
    );
}

/** Closes assignment `id` as `finish` does, then stops the run of its open turn, if any: the one way the tick closes one. */
export async function closeAssignment(desk: Desk, id: string, outcome: string) {
  const s = assignmentOf(desk.db, id);
  if (!s) {
    return;
  }
  const open = openTurn(desk.db, s.agent_id);
  await closeWithdrawing(desk, s, outcome);
  if (open?.assignment_id === id) {
    await stopOpenRun(desk, s.agent_id, open);
  }
}

/**
 * Commits agent `a`'s home (`agentHomeOf`) and its assignment `s`'s folder in his agents repo (`desk.agentsRepo`) after
 * a turn: in code, never left to the agent. A failure is logged, never fatal.
 */
export function commitAgentFiles(a: AgentRow, s: AssignmentRow) {
  const repo = settings().desk?.agentsRepo;
  if (!repo) {
    return;
  }
  const paths = [agentHomeOf(repo, a), dirname(s.notes_path)].flatMap((p) => {
    const inRepo = p ? pathInside(repo, p) : null;
    return inRepo === null ? [] : [inRepo || "."];
  });
  try {
    commitPaths(repo, [...new Set(paths)], `desk: ${a.id}'s turn on ${s.id}`);
  } catch (error) {
    log("desk.runtime", {
      agent: a.id,
      ...errorOf(error),
      ok: false,
      what: "commit",
    });
  }
}

/** `write_notes`: replaces assignment `s`'s notes file, which opens its next packet and every wake's record (`matterRecordOf`). */
export function writeNotes(desk: Desk, s: AssignmentRow, text: string) {
  mkdirSync(dirname(s.notes_path), { recursive: true });
  writeFileSync(s.notes_path, text);
  heard(desk, s);
}

/**
 * `request_decision`: asks him as the desk, stamped with the agent's id and its session's link first, one open card
 * per assignment, filed under the assignment holding its subject's matter (`cardHomeOf`, the woken one or another of its
 * agent's) and never on a step another assignment of its agent is anchored on (`siblingOn`); or withdraws one of this
 * assignment's own cards. `requestDecision` checks the rest, then hands the card's write to the desk's claim, which
 * writes it in one transaction with the row saying it is that assignment's (`card`, read by `assignmentOfCard`) and, on a
 * matter, the anchor on the subject Life stores (a matter's id is stored as one of its steps): all or, when any fails,
 * none, so no other ask's anchor is ever taken back. The line names its assignment and matter, so a stop between the
 * line and the commit leaves the card its owner; never an anchor alone.
 */
export async function askDecision(
  desk: Desk,
  s: AssignmentRow,
  { keep, withdraw, why, ...ask }: z.infer<typeof DecisionRequest>
) {
  const { db } = desk;
  const id = s.agent_id;
  heard(desk, s);
  const isMine = (card?: string, of = s) =>
    cardsOf(db, of, decisionsNow()).some((d) => d.id === card);
  if (withdraw) {
    const card = cardsOf(db, s, decisionsNow()).find((d) => d.id === withdraw);
    if (!card) {
      throw new Error(
        `Not done: ${withdraw} is not a card of this turn's assignment (${s.id}).`
      );
    }
    return requestDecision(DESK_AGENT, { agent: card.agent, why, withdraw });
  }
  if (keep) {
    const held = decisionsNow().find((d) => d.id === keep)?.contests;
    if (!isMine(held)) {
      throw new Error(`Not done: ${keep} waits on no card of ${s.id}.`);
    }
    return requestDecision(DESK_AGENT, { agent: id, keep, why });
  }
  const { home, matter, subject } = await cardHomeOf(db, s, ask.subject);
  const steps = anchorsOf(db, home.id);
  const link = agentOf(db, id)?.link;
  // Whether it is the plan card, read now and again when written (`claim`): a card asked or withdrawn meanwhile changes it.
  const isPlan = asksPlanOf(db, home);
  const claim = (
    on: string | undefined,
    decision: string,
    merging: string | undefined,
    write: (stamps: { assignment: string }) => void
  ) => {
    if (merging && !isMine(merging, home)) {
      throw new Error(`Not done: ${merging} is no card of ${home.id}.`);
    }
    // One card at a time per assignment (an inbox rule, not a limit on its work), checked after every await; a merge's own card goes with it.
    // Its assignment may have closed or moved to another agent while the ask was read.
    const now = assignmentOf(db, home.id);
    if (!now || now.closed_at || now.agent_id !== home.agent_id) {
      throw new Error(`Not done: ${home.id} closed or moved; ask again.`);
    }
    const open = pendingCardOf(db, home);
    if (open && open.id !== merging) {
      throw new Error(
        `Not done: ${id} already asks ${open.id}; withdraw it or wait for his answer.`
      );
    }
    if (asksPlanOf(db, home) !== isPlan) {
      throw new Error(`Not done: ${home.id}'s first card changed; ask again.`);
    }
    const sibling = on && siblingOn(db, home, on);
    if (sibling) {
      throw new Error(
        `Not done: ${on} is ${sibling}'s, another assignment of yours: ask on it from its own turn.`
      );
    }
    db.transaction(() => {
      db.run("insert into card (decision_id, assignment_id) values (?, ?)", [
        decision,
        home.id,
      ]);
      if (steps.length > 0 && on) {
        db.run(
          "insert or ignore into anchor (assignment_id, step, added_at) values (?, ?, ?)",
          [home.id, on, clock().toISOString()]
        );
      }
      write({ assignment: home.id });
    })();
  };
  return requestDecision(
    DESK_AGENT,
    {
      ...ask,
      agent: id,
      links: [...(link ? [link] : []), ...(ask.links ?? [])],
      ...(subject ? { subject } : {}),
    },
    undefined,
    undefined,
    { claim, isPlan, prefer: matter }
  );
}

/**
 * `read_card`: a card in a contest with one of assignment `s`'s, as data: one waiting on its card (`draft.contested`),
 * or its own waiting card (`draft.kept`: the holder's why). Never one of another contest.
 */
export function readCard({ db }: Desk, s: AssignmentRow, id: string) {
  const all = decisionsNow();
  const mine = new Set(cardsOf(db, s, all).map((x) => x.id));
  const d = all.find((x) => x.id === id);
  if (!(d && (mine.has(d.id) || mine.has(d.contests ?? "")))) {
    throw new Error(`Not done: ${id} is in no contest with a card of ${s.id}.`);
  }
  const { agent, asker, context, contests, draft, kept, options } = d;
  const { question, replaces, state, title } = d;
  return {
    asker: agent ?? asker,
    contests: contests ?? null,
    context,
    draft: draft ?? null,
    id,
    kept: kept?.why ?? null,
    options: options.map((o) => o.label),
    question,
    replaces: replaces ?? null,
    state,
    title,
  };
}

/** Where an agent may write, what it never starts, how it waits, and which matter his own words in its session are about (his rulings of 20 Nov 2026): Life keeps its notes; the desk alone dispatches and wakes. */
const BOUNDS =
  ' Your notes go only through `write_notes` (Life keeps them and commits them, with your home in his agents repo, after each turn): never in a project\'s repo, which you change only on a card he approved. Your session is your one conversation, resumed on every wake and compacted by your runtime when full: keep your notes current before you compact. Never start a session or a scheduled task of your own to track a matter: the desk wakes you; sub agents inside a turn are fine. Wait only with `set_wait`, never with a Monitor, a loop or a scheduled task: when it cannot hold what you wait for, say so in one line and stop. `github` is a wait channel: a filter naming it (`channels: ["github"]`, with `text_matches`, `person` or `chat`) wakes you on new issues and comments of the repos he lists (`githubRepos`). When he writes in your session himself and you hold several matters, work out from his words which one he means, ask him only when that is unclear, and name the matter before you act. A turn he started by writing in your session: he is here, so answer and ask him in the chat; anything outward is still a card (`request_decision`), approved only on the card in his Life app, never by his yes in the chat, so tell him it waits there. A turn the desk started (a wake, his answer, a deadline): he is away, so every question or decision that needs his answer goes as a card, never a question left in the chat, which he will not see.';

/** The one sentence of the contract that differs: what a first turn does when he asked for the agent (his plan card, then his `start`). */
const PLAN_FIRST_TURN =
  ' Your first turn only reads and asks your plan card (`fetch("ask/plan")`): its steps as `plan`, what it rests on as `gathered`, its `context` in Markdown (what you read, why this plan, not the steps again), a question of one line ending in a ? (such as "Start with this plan?"), and exactly two options, `start` ("Start the plan") and `decline` ("Not this plan"). Act only after his `start`; on his `decline`, `finish`; on his own words instead, read them and ask again.';

/** ... and when the desk started it itself (`hand-out.ts`): no plan card, one card of what it found. */
const HANDED_OUT_FIRST_TURN =
  ' Life handed you this matter from the top of his list; he did not ask for it. Your first turn reads and gathers (his chats, mail, files, the web), then asks ONE card, whichever is true: the next step prepared (a draft he can send as it is, in the channel the talk is already in, never mail when they talk in a chat); what only he can do (the step in a few words and every fact he needs for it: amount, account, address, phone, reference); or that it looks over (what shows it). Open the card\'s context with what you could not verify. On a card for what only he can do, or that it looks over, mark the option that means done `ends: "step"` (the step as `subject`) or `ends: "matter"` (nothing is left): his pick closes it in Life. Every card also offers Drop it, marked `ends: "matter"`, for a matter he does not care about: his pick of it alone closes the matter in Life (when the matter has no open step left, Life refuses it: leave it out and say in the context that he can tell you to stop). No other option closes anything. Then wait for his answer; finish when the step is done or nothing is left for you.';

/** How a hand-out's card reads (his word of 21 Nov 2026: a card must read well): its plan in Markdown in `context`, its question one line. The plan card gives its steps as `plan` instead. */
const PLAN_IN_MARKDOWN =
  " Write that card's plan in Markdown in its `context`: a short heading, numbered steps, what you wait on, and what you will ask him; its question stays one line.";

/** ... and the caretaker's (by its role): his complaint's words are its plan (his yes of 20 Nov 2026). */
const CARETAKER_FIRST_TURN =
  " Your first turn reads each complaint it was woken on (`read_complaint`) and starts on it: his words are your plan, so ask no plan card and wait for no `start`. A change still goes to him first, as a card with the exact change.";

/** What an assignment's first turn does: the caretaker's by its role; else his plan card first when he opened it, one card of what it found, its plan in Markdown, when the desk did. */
export const firstTurnOf = (a: Pick<AgentRow, "role">, openedBy: OpenedBy) => {
  if (a.role === "caretaker") {
    return CARETAKER_FIRST_TURN;
  }
  return openedBy === "desk"
    ? `${HANDED_OUT_FIRST_TURN}${PLAN_IN_MARKDOWN}`
    : PLAN_FIRST_TURN;
};

/** What an agent of his own Life is told of the send guard (`send-guard.ts`), and of the repos it may post to itself. */
function sendGuardLines() {
  const repos = settings().desk?.agentPostRepos ?? [];
  return ` Life's send guard refuses any message, mail, invitation to others or messaging site or app that is not a card's draft, and says why. It also refuses his Life connector's writes (\`answer_check\`, \`request_decision\`, \`tell_life\` and the other changes): ask him through your door's \`request_decision\`. If your door is missing, say so in one line and stop, even when Life reminds you once to set a wait: it then waits 24 hours, or for the events you last waited on, before your next turn, and keeps no notes from this one.${repos.length > 0 ? ` One exception: on ${repos.join(", ")} you may comment, open an issue or review yourself with \`gh\` (its \`--repo\` named, the body given with \`--body\` and ending with this line: ${AGENT_POST_SIGNATURE}). People read it there in his name without his yes on the text: post only facts and questions; anything that commits him (a price, money, a date, a promise, a client) goes on a card.` : ""}`;
}

/** What every session of a registered agent is told after its brief (the desk spec, 5.4): the door's contract and his one gate (what waits on his yes, a plan before any act). */
const contractOf = (id: string, isOwn: boolean, firstTurn: string) =>
  `You are ${id}, a registered agent of the owner's desk${isOwn ? ": one of his own sessions, in full" : ""}. Your door (the \`desk\` MCP server) has your tools: call \`read_packet\` when you start; before you stop, write your notes (\`write_notes\`) and call \`set_wait\` (what you wait for, until when) or \`finish\`. His own rules apply as in any session of his. ${isOwn ? "Free, never ask: this Mac is yours for the job. Read and search any file, his mail and his messages; browse and search the web; run commands; install what you need; use every tool, connector, CLI and key his sessions have, his 1Password included." : "You have your door's tools only."} The one gate: anything that acts outward in his name (a message or mail to anyone but him, a post, a payment, a booking, an acceptance, changing or deleting something outside this Mac that others see) happens only on his yes to that exact thing, asked through \`request_decision\`, one at a time; a message goes as the card's draft, which Life sends on his yes. Nothing else is gated. Write a card's \`context\` in Markdown: why you ask, why this draft, what you tried; link Life's things as \`[words](life:<ref>)\` with any ref \`fetch\` opens (\`unit_…\`, \`obs_…\`, \`matter_…\`, \`msg:<source>|<message id>\`, \`file:<ref>\`, a turn, \`person:<id>/now\`), and quote as \`> …\` then \`*source*\`; a dead link refuses the card.${isOwn ? `${sendGuardLines()} Reaching him: a decision is a card; something worth knowing while he is away may be mailed to him as his rules say (mail to him is not outward).` : ""}${BOUNDS}${firstTurn} A \`call.ended\` event is a call of his that ended, with the recording his pendant made of it. Read each of its \`recordings\` with \`fetch\` (\`id\` its \`turn\`, \`at\` and \`until\` the call's, reading on with \`fromTurn\` while more remain): Life cuts it to the call's exact span, a turn crossing an edge to its words inside, because the recording began before the call and went on after it, and nothing said outside those instants is the call's or may be quoted or sent. A call in \`read_chats\` gives its span the same way (\`call at … until …\`): cut any read of its recording with it. \`people\` is who may have been on it, not who spoke when: someone may have joined late. Voices heard through a speaker are often unnamed or merged into one: write such a line as an unnamed remote voice, never under a name the recording does not give. A \`payment.booked\` event is a payment his money app holds; its merchant and note are not in the wake. An \`arrival.confirmed\` event is one or more new messages Life's reader confirmed hold an ask, a promise or a wait for him (their chat, the newest one's id, when Life confirmed them and who wrote them, never their words): read the chat yourself. It may be a recorded conversation (its chat is the conversation id; fetch its turn ref), and it may be his own commitment (something he said he will do), not only an ask of him. A \`stay.arrived\` event is an arrival at a place; its name is not in the wake, and one real arrival may wake you more than once (the same place, minutes apart: act once). A wait can watch GitHub: \`channels: ["github_activity"]\` with \`repo: "owner/name"\` (or \`"owner/*"\`); you wake on its issues, PRs, comments and reviews, with facts only (repo, number, who, kind, link): read the rest with \`gh\`.`;

const NONE =
  "(none in his directory: find them with `read_chats` and `read_people_and_organizations`, and tell him who or which chat is missing)";

/** A project agent's subject: the project, then its people and chats as his directory holds them (what a wait's `person` and `chat` take). */
async function projectLinesOf(project: string) {
  const line = `Your subject: the project ${project} (\`read_area_page\`). A matter of it that has its own agent is that agent's to draft on.`;
  const { nameOf, truth } = await readPeople();
  const held = projectPeopleAndChatsOf(truth, project);
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
    ...communicationStylesOf(
      held.people.map((p) => `person:${p.id}`),
      nameOf
    ),
  ].join("\n");
}

/**
 * A project in a packet, read as data: its line and his notes from his directory (`projectHeaderOf`, clipped to
 * `PROJECT_NOTES_MAX`); its running matters are `read_matters`'. Nothing for a project no longer in his directory.
 */
function projectContextOf({ projects }: Pick<Truth, "projects">, id: string) {
  const p = projects.find((x) => x.id === id);
  return p
    ? [
        [
          projectHeaderOf(p),
          clip(p.notes.trim(), PROJECT_NOTES_MAX),
          `Its running matters: \`read_matters\` with \`project: "${id}"\`.`,
        ]
          .filter(Boolean)
          .join("\n"),
      ]
    : [];
}

/** An assignment's subject as its packet opens: a standing role's (the caretaker's: Life's data, never a matter), else its project's lines on its own assignment, else its matter as read now. */
async function subjectLineOf(
  a: Pick<AgentRow, "project" | "role">,
  isOnProject: boolean,
  matter: { id: string } | undefined,
  steps: readonly string[]
) {
  if (a.role === "caretaker") {
    return "Your subject: Life's data. Your work is his complaints, each a `complaint.received` event naming one (`read_complaint`); you hold no matter.";
  }
  return isOnProject && a.project
    ? await projectLinesOf(a.project)
    : `Your subject, the matter as read now (\`read_matter\` with ${matter?.id ?? steps[0] ?? "its step"} reads it again):\n${JSON.stringify(matter ?? `No matter holds ${steps.join(", ")} now.`)}`;
}

/**
 * `read_packet`: what a fresh session starts from: its one matter as read now (`oneMatter`: where it stands, its goal and
 * next step, its steps so far), or its project; then each project's context (`projectContextOf`), the brief, the
 * contract, its notes, its agent wait, its queued events (facts only) and its open decision. When it starts turn `turn`'s
 * fresh session, that turn is shown every step of the matter this one read holds (`keepHanded`).
 */
export async function readPacket(
  { db }: Desk,
  s: AssignmentRow,
  isOwn: boolean,
  turn?: number
) {
  const a = agentOf(db, s.agent_id);
  if (!a) {
    return "";
  }
  const held = agentWaitOf(a, s);
  const events = queuedEvents(db, s.id).map(eventLineOf);
  const steps = anchorsOf(db, s.id);
  // An agent's own assignment is its project; any other, the matter its anchors find, its agent's project as context.
  const isOnProject = steps.length === 0 && a.project !== null;
  const prefer = s.matter_id ?? undefined;
  const matter = isOnProject ? undefined : await oneMatter(steps, { prefer });
  if (turn !== undefined && steps.length > 0) {
    pendingOf(db).set(s.id, {
      steps: (matter?.steps ?? []).map((x) => x.ref),
      turn,
    });
  }
  const truth = await loadTruth();
  const projects = [
    ...new Set([
      ...(a.project ? [a.project] : []),
      ...(isOnProject ? [] : await readMatterProjectIds(steps, prefer)),
    ]),
  ].map((p) => projectContextOf(truth, p));
  return [
    await subjectLineOf(a, isOnProject, matter, steps),
    ...projects.flat(),
    a.brief,
    contractOf(a.id, isOwn, firstTurnOf(a, s.opened_by)),
    `Your notes:\n${readNotes(s) || "(none yet)"}`,
    ...(held
      ? [
          `Your wait${held.isDefault ? " (the default: the desk set it, replace it with set_wait)" : ""}: ${JSON.stringify({ events: held.events, reason: held.reason, until: held.until })}`,
        ]
      : []),
    `Events waiting:\n${events.join("\n") || "(none)"}`,
    `Your open decision: ${pendingCardOf(db, s)?.id ?? "none"}`,
  ].join("\n\n");
}

/**
 * The matter steps the turn on each assignment was shown (`matterRecordOf`), by assignment, in this process: kept as
 * shown (`handed_step`) once that turn ends unfailed (`keepHanded`), forgotten on a re-point (`writeSubject`). Lost on a
 * restart: those steps are then shown again.
 */
const pending = new WeakMap<
  Desk["db"],
  Map<string, { steps: string[]; turn: number }>
>();
function pendingOf(db: Desk["db"]) {
  const turns =
    pending.get(db) ?? new Map<string, { steps: string[]; turn: number }>();
  pending.set(db, turns);
  return turns;
}

/** Keeps as shown the steps turn `t` was shown when `isKept` (it ended unfailed), and forgets them: a failed turn shows them again. */
export function keepHanded(
  db: Desk["db"],
  t: { assignment_id: string; id: number },
  isKept: boolean
) {
  const p = pendingOf(db).get(t.assignment_id);
  if (p?.turn !== t.id) {
    return;
  }
  for (const step of isKept ? p.steps : []) {
    db.run(
      "insert or ignore into handed_step (assignment_id, step) values (?, ?)",
      [t.assignment_id, step]
    );
  }
  pendingOf(db).delete(t.assignment_id);
}

/**
 * What every wake of a matter assignment `s` opens with, from code (his word of 20 Nov 2026: nothing rests on the
 * agent's memory): the matter as Life reads it now (its id and name, where it stands, its goal and next step), its steps
 * the assignment was never shown (`handedSteps`: a step Life learned late about an earlier hour included; the newest
 * `RECORD_STEPS`, and how many more), its notes, and where to read more; a few thousand characters at most. Life's own
 * reading of the matter, never an event's words. Turn `turn` is shown the steps listed (`keepHanded`); a fresh session's
 * packet holds the whole matter instead (`readPacket`).
 */
export async function matterRecordOf(
  { db }: Desk,
  s: AssignmentRow,
  turn: number
) {
  const anchors = anchorsOf(db, s.id);
  const m = await oneMatter(anchors, { prefer: s.matter_id ?? undefined });
  const handed = handedSteps(db, s.id);
  const fresh = (m?.steps ?? []).filter((x) => !handed.has(x.ref));
  const shown = fresh.slice(-RECORD_STEPS);
  pendingOf(db).set(s.id, { steps: shown.map((x) => x.ref), turn });
  return [
    `Your matter, as Life reads it now (\`read_matter\` with ${m?.id ?? anchors[0] ?? "its step"} reads it whole; your notes file: ${s.notes_path}):`,
    m
      ? JSON.stringify({
          goal: m.goal?.text,
          id: m.id,
          name: m.name,
          nextStep: m.nextStep?.text,
          status: m.status,
        })
      : `No matter holds ${anchors.join(", ")} now.`,
    "Its steps new to you (never shown to you before):",
    ...shown.map(
      (x) =>
        `- ${x.at} ${x.ref} (${x.kind}): ${clip(x.text, RECORD_STEP_CHARS)}`
    ),
    ...(fresh.length === 0 ? ["(none)"] : []),
    ...(fresh.length > shown.length
      ? [
          `(and ${fresh.length - shown.length} older, listed next time: \`read_matter\`)`,
        ]
      : []),
    `Your notes on it:\n${clip(readNotes(s), RECORD_NOTES_CHARS) || "(none yet)"}`,
  ].join("\n");
}
