import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { DESK_AGENT } from "../core/names";
import { DESK_AGENT_FOLDERS } from "../core/paths";
import { settings } from "../core/settings";
import { asksFor } from "../host/asks";
import {
  agentChangeOf,
  agentOf,
  currentAssignmentOf,
  holderOf,
  isFull,
  readCursor,
  runtimeOf,
  standingAgents,
} from "../host/desk-read";
import { matterFinderOf } from "../memory/matter-read";
import { readMatterBook } from "../memory/matters";
import { agentForMatterOf } from "../memory/read-matters";
import { readPeople } from "../memory/who";
import { dayNow } from "../memory/zones";
import { AgentChange } from "../records/registered-agent";
import {
  openAssignment,
  register,
  stopOpenRun,
  withdrawOpenCards,
  writeSubject,
} from "./agent-actions";
import { closeAssignmentRow, type Desk, saveCursor } from "./desk-store";

// His word about his registered agents (`change_registered_agent`): each is an ask of the desk (`DESK_AGENT`) in the
// ledger, read here every tick from the desk's own cursor and applied once, in code. What was done, or why not, is the
// ask's `agent_change` row, which the connector waits for. Life-side facts (his subject's matter or project) were
// checked before the ask was written; the desk's own (which agent, its status, the runtime, the folder) are checked here.

const CURSOR = "asks";
/** An ask older than this when first read is refused, not applied late (the desk was off or stopped meanwhile). */
const STALE_AFTER = 10 * MIN;

const now = () => clock().toISOString();

/** Why a change to `id` is refused, from its status; null when it may go ahead. */
function statusRefusal(desk: Desk, id: string | undefined, allowed: string[]) {
  const a = id ? agentOf(desk.db, id) : null;
  if (!a) {
    return `no registered agent ${id ?? "named"}`;
  }
  return allowed.includes(a.status) ? null : `${a.id} is ${a.status}`;
}

/** Why a resume is refused: not stopped, or the desk at its cap (a resume then would hide another agent's work from the clock, `openAssignments`). */
const resumeRefusal = (desk: Desk, id: string | undefined) =>
  statusRefusal(desk, id, ["stopped"]) ??
  (isFull(desk.db) ? "the desk keeps 50 agents active at most" : null);

/** Why a change names not exactly one subject: a matter's steps, a project, or the Personal agent. */
const subjectCountRefusal = (c: AgentChange) =>
  [c.steps, c.project, c.role].filter(Boolean).length === 1
    ? null
    : 'name exactly one subject: a matter (`step`), a project, or `role: "personal"`';

/** Why a subject is refused: not exactly one (`subjectCountRefusal`); a re-point of the caretaker (`self`), which takes no other subject; another Personal agent active or stopped; the matter held by another active agent. */
function subjectRefusal(desk: Desk, c: AgentChange, self?: string) {
  if (self && agentOf(desk.db, self)?.role === "caretaker") {
    return "the caretaker takes no other subject";
  }
  const counted = subjectCountRefusal(c);
  if (counted) {
    return counted;
  }
  if (c.role === "personal") {
    const other = desk.db
      .query<{ id: string; status: string }, [string]>(
        "select id, status from agent where role = 'personal' and status in ('active', 'stopped') and id <> ?"
      )
      .get(self ?? "");
    return other ? `the Personal agent is ${other.id} (${other.status})` : null;
  }
  const holder = holderOf(desk.db, c.steps ?? []);
  return holder && holder !== self
    ? `that matter is already held by ${holder}`
    : null;
}

/** Where the Personal agent's sessions start when he names no folder: its home in his agents repo (`agentHomeOf`), else under the desk's folders. */
const personalHome = () =>
  join(settings().desk?.agentsRepo ?? DESK_AGENT_FOLDERS, "personal");

/**
 * Starts on his words (`brief`). On a matter: an assignment of the agent that takes it (`taker`, `agentForOf`), his words
 * kept as `said`; an agent that holds it already answers. On a project or as the Personal agent: a new agent, on a
 * runtime the desk drives that answers (`blocked`: why it can't now), in a folder that exists when one is named (the
 * Personal agent's home by default). A repeat (an active agent on the same project, or the Personal agent, started on
 * the same words) is that agent, not a refusal. A start hands over the stopped agents on its subject.
 */
export function start(
  desk: Desk,
  c: AgentChange,
  brief: string,
  { blocked, taker }: { blocked?: string; taker?: string } = {}
): { error: string } | { id: string } {
  const counted = subjectCountRefusal(c);
  if (counted) {
    return { error: counted };
  }
  if (c.steps) {
    // Held already: its holder answers (a matter's one other refusal).
    const holder = holderOf(desk.db, c.steps);
    if (holder) {
      return { id: holder };
    }
    if (!taker) {
      return {
        error:
          "no agent takes this matter: start the Personal agent, or an agent on its project",
      };
    }
    openAssignment(desk, taker, {
      openedBy: "owner",
      said: brief,
      steps: c.steps,
    });
    replaceStopped(desk, c, taker);
    return { id: taker };
  }
  const refused = subjectRefusal(desk, c);
  const runtime = runtimeOf(c);
  const repeat = desk.db
    .query<{ id: string }, [string, string | null, number]>(
      "select id from agent where status = 'active' and brief = ? and (project = ? or (role = 'personal' and ? = 1)) limit 1"
    )
    .get(brief, c.project ?? null, c.role === "personal" ? 1 : 0)?.id;
  if (repeat) {
    return { id: repeat };
  }
  if (!(runtime && desk.runtimes[runtime])) {
    return {
      error: `name a runtime: ${Object.keys(desk.runtimes).join(", ")}`,
    };
  }
  if (c.folder && !(isAbsolute(c.folder) && existsSync(c.folder))) {
    return {
      error: "the folder its sessions start in must be absolute and exist",
    };
  }
  if (blocked) {
    return { error: `${runtime} does not answer: ${blocked}` };
  }
  if (refused) {
    return { error: refused };
  }
  const id = register(desk, {
    brief,
    effort: c.effort,
    folder: c.folder ?? (c.role === "personal" ? personalHome() : undefined),
    model: c.model,
    name: c.name,
    project: c.project,
    role: c.role,
    runtime,
  });
  replaceStopped(desk, c, id);
  return { id };
}

/**
 * He stopped an agent, then started `id` on its subject: on a matter, the stopped agents' assignments anchored on its
 * steps close; on a project, the own assignment of its stopped agents. Their other assignments stay (the fold moves
 * them); an agent left with none is replaced.
 */
function replaceStopped(desk: Desk, c: AgentChange, id: string) {
  const onSubject = c.steps
    ? "s.id in (select assignment_id from anchor where step in (select value from json_each(?)))"
    : "a.project = ? and s.id not in (select assignment_id from anchor)";
  for (const { id: old } of desk.db
    .query<{ id: string }, [string | null]>(
      `select s.id from assignment s join agent a on a.id = s.agent_id where a.status = 'stopped' and s.closed_at is null and ${onSubject}`
    )
    .all(c.steps ? JSON.stringify(c.steps) : (c.project ?? null))) {
    closeAssignmentRow(desk.db, old, {
      outcome: `replaced by ${id}`,
      replaced: true,
    });
  }
}

/** His rename or model change: the agent's columns it sets. */
const writeColumns = ({ db }: Desk, id: string, c: AgentChange) =>
  c.action === "rename"
    ? db.run("update agent set name = ? where id = ?", [c.name ?? null, id])
    : db.run("update agent set model = ?, effort = ? where id = ?", [
        c.model ?? null,
        c.effort ?? null,
        id,
      ]);

/**
 * His re-point of agent `id`: on a matter, the assignment it works on is anchored there; on a project or as the Personal
 * agent, the agent's own subject changes and its matters' assignments keep their anchors, and an agent that had none of
 * its own (a matter's agent until now) gets one, so it stands when the fold moves its matters away.
 */
function rePoint(desk: Desk, id: string, c: AgentChange) {
  const { db } = desk;
  if (c.steps) {
    writeSubject(desk, id, currentAssignmentOf(db, id)?.id ?? "", c);
    return;
  }
  writeSubject(desk, id, "", c);
  const hasOwn = db
    .query<{ id: string }, [string]>(
      "select id from assignment where agent_id = ? and closed_at is null and id not in (select assignment_id from anchor) limit 1"
    )
    .get(id);
  if (!hasOwn) {
    openAssignment(desk, id, { openedBy: "owner" });
  }
}

/** Applies one change in the store; what it touched, or why not. */
function apply(
  desk: Desk,
  c: AgentChange,
  brief: string,
  facts: { blocked?: string; taker?: string }
): { error: string } | { id: string } {
  const { db } = desk;
  const id = c.agent ?? "";
  const refusal = (allowed: string[]) => statusRefusal(desk, c.agent, allowed);
  /** The agent active again, the assignment it works on due now. */
  const due = (reason: string) => {
    db.run(
      "update agent set status = 'active', stopped_at = null where id = ?",
      [id]
    );
    db.run(
      "update assignment set wait_until = ?, wait_reason = ?, wait_is_default = 0 where id = ?",
      [now(), reason, currentAssignmentOf(db, id)?.id ?? ""]
    );
  };
  let refused: string | null;
  switch (c.action) {
    case "start":
      return start(desk, c, brief, facts);
    case "stop":
      refused = refusal(["active"]);
      if (!refused) {
        db.run(
          "update agent set status = 'stopped', stopped_at = ? where id = ?",
          [now(), id]
        );
      }
      break;
    case "resume":
      refused = resumeRefusal(desk, c.agent);
      if (!refused) {
        due("resumed");
      }
      break;
    case "re_point":
      refused = refusal(["active", "stopped"]) ?? subjectRefusal(desk, c, id);
      if (!refused) {
        rePoint(desk, id, c);
        if (agentOf(db, id)?.status === "active") {
          due("its subject changed");
        }
      }
      break;
    default:
      // rename, change_model
      refused =
        refusal(["active", "stopped"]) ??
        (c.action === "rename" && !c.name ? "give its `name`" : null);
      if (!refused) {
        writeColumns(desk, id, c);
      }
      break;
  }
  return refused ? { error: refused } : { id };
}

/** The agent that takes the matter some refs find (`agentForMatterOf`, among the standing agents), the book read once. */
async function readTakerOf(db: Desk["db"]) {
  const people = await readPeople();
  const find = matterFinderOf(await readMatterBook(people, dayNow()));
  const take = agentForMatterOf(standingAgents(db), people.truth);
  return (refs: readonly string[]) => {
    const v = find(refs);
    return v && take(v);
  };
}

/** What a start reads before its transaction (a process, a book): on a matter, the agent that takes it (`readTakerOf`); else whether its runtime answers. */
async function startFactsOf(desk: Desk, change: unknown) {
  const c = AgentChange.safeParse(change);
  if (!(c.success && c.data.action === "start")) {
    return {};
  }
  if (c.data.steps) {
    return { taker: (await readTakerOf(desk.db))(c.data.steps) };
  }
  const runtime = runtimeOf(c.data);
  return {
    blocked: runtime ? await desk.runtimes[runtime]?.block() : undefined,
  };
}

/** What the desk does with one ask: why it is refused (spoken, stale, or the change refused), else the change applied. */
function applyAsk(
  desk: Desk,
  ask: ReturnType<typeof asksFor>["asks"][number],
  facts: { blocked?: string; taker?: string }
): { agent?: string; error: string } | { agent?: string; id: string } {
  const parsed = AgentChange.safeParse(ask.agentChange);
  if (!parsed.success) {
    return { error: "only a change from `change_registered_agent` is applied" };
  }
  if (clock().getTime() - Date.parse(ask.at) > STALE_AFTER) {
    return {
      agent: parsed.data.agent,
      error: "asked over 10 minutes before the desk read it",
    };
  }
  // Its own savepoint: a change that throws leaves nothing half written, only its error row.
  try {
    return {
      agent: parsed.data.agent,
      ...desk.db.transaction(() =>
        apply(desk, parsed.data, ask.quote, facts)
      )(),
    };
  } catch (e) {
    return { agent: parsed.data.agent, error: (e as Error).message };
  }
}

/**
 * Applies his new asks of the desk, each once: a change and its row (`agent_change`) are written in one transaction,
 * so a restart neither applies one twice nor skips one. A stopped agent's open decision is withdrawn after.
 */
export async function applyAgentChanges(desk: Desk) {
  const { db } = desk;
  const page = asksFor(DESK_AGENT, readCursor(db, CURSOR) ?? undefined);
  for (const ask of page.asks) {
    // biome-ignore lint/performance/noAwaitInLoops: his asks apply in the order he gave them
    const facts = await startFactsOf(desk, ask.agentChange);
    const r = db.transaction(() => {
      if (agentChangeOf(db, ask.id)) {
        return null;
      }
      const done = applyAsk(desk, ask, facts);
      const agent = "id" in done ? done.id : (done.agent ?? null);
      db.run(
        "insert into agent_change (ask, agent_id, error, applied_at) values (?, ?, ?, ?)",
        [ask.id, agent, "error" in done ? done.error : null, now()]
      );
      return { ...done, agent };
    })();
    if (!r) {
      continue;
    }
    log("desk.change", { ask: ask.id, ...r });
    if ("id" in r && (ask.agentChange as AgentChange).action === "stop") {
      // His stop ends the turn under way too (his yes of 20 Nov 2026): its run is stopped, the turn closes `failed`.
      await stopOpenRun(desk, r.id);
      await withdrawOpenCards(
        db,
        { agent_id: r.id },
        "he stopped its agent"
      ).catch((e: Error) =>
        log("desk.change", {
          ask: ask.id,
          error: e.message,
          what: "withdraw",
        })
      );
    }
  }
  saveCursor(db, CURSOR, page.cursor);
}
