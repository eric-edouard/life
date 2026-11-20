import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { DESK_AGENT } from "../core/names";
import { asksFor } from "../host/asks";
import {
  agentChangeOf,
  agentOf,
  currentAssignmentOf,
  holderOf,
  projectHolderOf,
  readCursor,
  runtimeOf,
} from "../host/desk-read";
import { AgentChange, type OpenedBy } from "../records/registered-agent";
import {
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

/** Why a subject is refused: not exactly one of a matter's steps or a project, or the matter held by another active agent. */
function subjectRefusal(desk: Desk, c: AgentChange, self?: string) {
  if (!c.steps === !c.project) {
    return "name exactly one subject: a matter (`step`) or a project";
  }
  const holder = holderOf(desk.db, c.steps ?? []);
  return holder && holder !== self
    ? `that matter is already held by ${holder}`
    : null;
}

/**
 * Starts an agent on his words (`brief`): his subject, a runtime the desk drives that answers (`blocked`: why it can't
 * now), a folder that exists when one is named. A repeat (an active agent on the same subject, its matter or its
 * project, started on the same words) is that agent, not a refusal. A new agent hands over the stopped agents on its subject.
 */
export function start(
  desk: Desk,
  c: AgentChange,
  brief: string,
  { blocked, openedBy }: { blocked?: string; openedBy?: OpenedBy } = {}
) {
  const runtime = runtimeOf(c);
  const holder = c.project
    ? projectHolderOf(desk.db, c.project, brief)
    : holderOf(desk.db, c.steps ?? []);
  if (holder && agentOf(desk.db, holder)?.brief === brief) {
    return { id: holder };
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
  const refused = subjectRefusal(desk, c);
  if (refused) {
    return { error: refused };
  }
  const id = register(desk, {
    brief,
    effort: c.effort,
    folder: c.folder,
    model: c.model,
    openedBy,
    project: c.project,
    runtime,
    steps: c.steps,
  });
  // He stopped an agent, then started this one on its subject (its project, or a step it is anchored on): its assignments
  // close, and it is replaced.
  for (const { id: old } of desk.db
    .query<{ id: string }, [string | null, string]>(
      "select s.id from assignment s join agent a on a.id = s.agent_id where a.status = 'stopped' and s.closed_at is null and (a.project = ? or a.id in (select s2.agent_id from anchor n join assignment s2 on s2.id = n.assignment_id where n.step in (select value from json_each(?))))"
    )
    .all(c.project ?? null, JSON.stringify(c.steps ?? []))) {
    closeAssignmentRow(desk.db, old, {
      outcome: `replaced by ${id}`,
      replaced: true,
    });
  }
  return { id };
}

/** Applies one change in the store; what it touched, or why not. */
function apply(
  desk: Desk,
  c: AgentChange,
  brief: string,
  blocked?: string
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
      return start(desk, c, brief, { blocked });
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
      refused = refusal(["stopped"]);
      if (!refused) {
        due("resumed");
      }
      break;
    case "re_point":
      refused =
        refusal(["active", "stopped"]) ??
        (agentOf(db, id)?.role === "caretaker"
          ? "the caretaker takes no other subject"
          : subjectRefusal(desk, c, id));
      if (!refused) {
        writeSubject(desk, id, currentAssignmentOf(db, id)?.id ?? "", c);
        if (agentOf(db, id)?.status === "active") {
          due("its subject changed");
        }
      }
      break;
    case "change_model":
      refused = refusal(["active", "stopped"]);
      if (!refused) {
        db.run("update agent set model = ?, effort = ? where id = ?", [
          c.model ?? null,
          c.effort ?? null,
          id,
        ]);
      }
      break;
    default:
      // `hand_over` (to another runtime) is not built and always refused; it stays in `AgentChange` only so the
      // connector's arguments stay stable until its next batch drops it (a change there forces a reconnect).
      refused = "a handover comes with the desk's next step";
  }
  return refused ? { error: refused } : { id };
}

/** What the desk does with one ask: why it is refused (spoken, stale, or the change refused), else the change applied. */
function applyAsk(
  desk: Desk,
  ask: ReturnType<typeof asksFor>["asks"][number],
  blocked?: string
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
        apply(desk, parsed.data, ask.quote, blocked)
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
    // A start asks its runtime first (a process, never inside the transaction).
    const c = AgentChange.safeParse(ask.agentChange);
    const runtime =
      c.success && c.data.action === "start" ? runtimeOf(c.data) : undefined;
    // biome-ignore lint/performance/noAwaitInLoops: his asks apply in the order he gave them
    const blocked = runtime ? await desk.runtimes[runtime]?.block() : undefined;
    const r = db.transaction(() => {
      if (agentChangeOf(db, ask.id)) {
        return null;
      }
      const done = applyAsk(desk, ask, blocked);
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
