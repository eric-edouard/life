import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { clock, MIN } from "../core/clock";
import { log } from "../core/log";
import { DESK_AGENT } from "../core/names";
import { settings } from "../core/settings";
import { asksFor } from "../host/asks";
import {
  agentChangeOf,
  agentOf,
  holderOf,
  readCursor,
} from "../host/desk-read";
import { AgentChange } from "../records/registered-agent";
import { register, withdrawOpenDecision, writeSubject } from "./agent-actions";
import { type Desk, saveCursor } from "./desk-store";

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

/** Starts an agent on his words (`brief`): his subject, a runtime the desk drives, a folder that exists. */
function start(desk: Desk, c: AgentChange, brief: string) {
  const runtime = c.runtime ?? settings().desk?.defaultRuntime;
  if (!(runtime && desk.runtimes[runtime])) {
    return {
      error: `name a runtime: ${Object.keys(desk.runtimes).join(", ")}`,
    };
  }
  if (!(c.folder && isAbsolute(c.folder) && existsSync(c.folder))) {
    return { error: "name the folder its sessions start in (absolute)" };
  }
  const refused = subjectRefusal(desk, c);
  return refused
    ? { error: refused }
    : {
        id: register(desk, {
          brief,
          effort: c.effort,
          folder: c.folder,
          model: c.model,
          project: c.project,
          runtime,
          steps: c.steps,
        }),
      };
}

/** Applies one change; what it touched, or why not. */
async function apply(
  desk: Desk,
  c: AgentChange,
  brief: string
): Promise<{ error: string } | { id: string }> {
  const { db } = desk;
  const id = c.agent ?? "";
  const refusal = (allowed: string[]) => statusRefusal(desk, c.agent, allowed);
  const due = (reason: string) =>
    db.run(
      "update agent set status = 'active', wait_until = ?, wait_reason = ?, wait_is_default = 0 where id = ?",
      [now(), reason, id]
    );
  let refused: string | null;
  switch (c.action) {
    case "start":
      return start(desk, c, brief);
    case "stop":
      refused = refusal(["active"]);
      if (!refused) {
        // ponytail: a turn under way ends on its own; `Runtime.stop` comes with the handover (step 5).
        db.run("update agent set status = 'stopped' where id = ?", [id]);
        await withdrawOpenDecision(id, "he stopped its agent");
      }
      break;
    case "resume":
      refused = refusal(["stopped"]);
      if (!refused) {
        due("resumed");
      }
      break;
    case "re_point":
      refused = refusal(["active", "stopped"]) ?? subjectRefusal(desk, c, id);
      if (!refused) {
        db.transaction(() => {
          writeSubject(desk, id, c);
          if (agentOf(db, id)?.status === "active") {
            due("its subject changed");
          }
        })();
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
      // ponytail: the handover (the desk spec, section 9) is step 5; its argument exists so the connector's stays stable.
      refused = "a handover comes with the desk's next step";
  }
  return refused ? { error: refused } : { id };
}

/**
 * Applies his new asks of the desk, each once: its row (`agent_change`) is written with the cursor past it, so a
 * restart neither applies one twice nor skips one. A spoken ask (no `agentChange` yet) or a stale one is refused.
 */
export async function applyAgentChanges(desk: Desk) {
  const { db } = desk;
  const page = asksFor(DESK_AGENT, readCursor(db, CURSOR) ?? undefined);
  for (const ask of page.asks) {
    if (agentChangeOf(db, ask.id)) {
      continue;
    }
    const parsed = AgentChange.safeParse(ask.agentChange);
    let r: { error: string } | { id: string };
    if (!parsed.success) {
      r = { error: "only a change from `change_registered_agent` is applied" };
    } else if (clock().getTime() - Date.parse(ask.at) > STALE_AFTER) {
      r = { error: "asked over 10 minutes before the desk read it" };
    } else {
      // biome-ignore lint/performance/noAwaitInLoops: his asks apply in the order he gave them
      r = await apply(desk, parsed.data, ask.quote).catch((e: Error) => ({
        error: e.message,
      }));
    }
    db.run(
      "insert or ignore into agent_change (ask, agent_id, error, applied_at) values (?, ?, ?, ?)",
      [
        ask.id,
        "id" in r ? r.id : (parsed.data?.agent ?? null),
        "error" in r ? r.error : null,
        now(),
      ]
    );
    log("desk.change", { ask: ask.id, ...r });
  }
  saveCursor(db, CURSOR, page.cursor);
}
