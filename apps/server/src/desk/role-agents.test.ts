import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { clock } from "../core/clock";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { agentInRole, agentOf, runtimeOf } from "../host/desk-read";
import { agentMoveReadOf } from "../host/move-read";
import { insertAgent } from "./agent-actions";
import { type Desk, openDesk } from "./desk-store";
import { roleAssignmentOf, roleStartBlockOf, standUp } from "./role-agents";
import { runnableAgentOf, startBlockOf } from "./runtime-fallback";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { sessionAgentOf } from "./turn-ends";

// A runtime per role (`desk.roleRuntimes`): a standing role's agent starts on its role's runtime; a role left out takes
// the desk's default. Made-up briefs.

let desk: Desk;

beforeAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  setSettings({
    desk: {
      defaultRuntime: "pi",
      roleRuntimes: { caretaker: "claude" },
      runtimes: {},
    },
  });
  desk = { db: openDesk(), runtimes: { pi: fakeRuntime().runtime } };
});

afterAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  setSettings({ desk: null });
});

test("a role takes its own runtime from the settings, a role left out the desk's default; the move offered starts from it", async () => {
  // Claude not driven: the caretaker still starts, pi being able to run (`startBlockOf`).
  expect(await roleStartBlockOf(desk, "caretaker", () => "")).toBeUndefined();
  expect(await roleStartBlockOf(desk, "personal", () => "")).toBeUndefined();
  desk.runtimes.claude = fakeRuntime().runtime;
  roleAssignmentOf(desk, "caretaker", "fix what went wrong", undefined);
  roleAssignmentOf(desk, "personal", "take his asks", undefined);
  expect(agentInRole(desk.db, "caretaker")?.runtime).toBe("claude");
  expect(agentInRole(desk.db, "personal")?.runtime).toBe("pi");
  // The move offered starts from its role's runtime too: the caretaker is home on Claude, so no move to the default.
  const read = (role: "caretaker" | "personal") =>
    agentMoveReadOf(
      desk.db,
      agentInRole(desk.db, role)?.id ?? "",
      clock().getTime()
    );
  expect([read("caretaker"), read("personal")]).toMatchObject([
    { moveTo: "codex" },
    { moveTo: "claude" },
  ]);
});

test("the main session and the caretaker stand from the desk's start: an agent row with no assignment, so no turn; once each; none after one never began; a finished one stands again", () => {
  const { db } = desk;
  db.run("delete from assignment");
  db.run("delete from agent");
  const stand = () => {
    standUp(desk, "main", "answer his words");
    standUp(desk, "caretaker", "fix what went wrong");
  };
  stand();
  stand();
  const rows = () =>
    db
      .query<{ id: string; role: string; status: string }, []>(
        "select id, role, status from agent order by created_at"
      )
      .all();
  expect(rows().map((r) => [r.role, r.status])).toEqual([
    ["main", "active"],
    ["caretaker", "active"],
  ]);
  expect(db.query("select count(*) as n from assignment").get()).toMatchObject({
    n: 0,
  });
  // A caretaker whose first turn never began: none again until a complaint (`roleStartBlockOf`); one that finished: again.
  const caretaker = agentInRole(db, "caretaker")?.id ?? "";
  db.run(
    "insert into assignment (id, agent_id, opened_at, opened_by, notes_path, why_not_started, closed_at) values ('asg_t', ?, ?, 'owner', '', 'never began', ?)",
    [caretaker, clock().toISOString(), clock().toISOString()]
  );
  db.run("update agent set status = 'ended', ended_at = ? where id = ?", [
    clock().toISOString(),
    caretaker,
  ]);
  stand();
  expect(agentInRole(db, "caretaker")?.id).toBe(caretaker);
  db.run("update assignment set why_not_started = null where id = 'asg_t'");
  stand();
  expect(agentInRole(db, "caretaker")).toMatchObject({ status: "active" });
  expect(agentInRole(db, "caretaker")?.id).not.toBe(caretaker);
});

test("a standing role's session is titled by its role until he names it", () => {
  const a = agentInRole(desk.db, "main");
  expect(a && sessionAgentOf(a).title).toBe("Agent: Ask Life");
  expect(a && sessionAgentOf({ ...a, name: "Mine" }).title).toBe("Agent: Mine");
});

test("a fresh install, no runtime in its settings: every role and every project's agent runs on pi", () => {
  setSettings({ desk: { runtimes: {} } });
  const { db } = desk;
  db.run("delete from assignment");
  db.run("delete from agent");
  standUp(desk, "main", "answer his words");
  standUp(desk, "caretaker", "fix what went wrong");
  roleAssignmentOf(desk, "personal", "take his asks", undefined);
  expect(
    (["main", "caretaker", "personal"] as const).map(
      (r) => agentInRole(db, r)?.runtime
    )
  ).toEqual(["pi", "pi", "pi"]);
  expect(runtimeOf({})).toBe("pi");
  setSettings({
    desk: {
      defaultRuntime: "pi",
      roleRuntimes: { caretaker: "claude" },
      runtimes: {},
    },
  });
});

test("a runtime that can't run: a start goes on pi; an agent with no session takes pi, once; one with a session stays", async () => {
  const claude = fakeRuntime();
  const pi = fakeRuntime();
  const d: Desk = {
    db: desk.db,
    runtimes: { claude: claude.runtime, pi: pi.runtime },
  };
  claude.blocked = "claude is not signed in";
  expect(await startBlockOf(d, "claude")).toBeUndefined();
  const { id: fresh } = insertAgent(d.db, {
    brief: "fix what went wrong",
    model: "opus",
    runtime: "claude",
  });
  const { id: kept } = insertAgent(d.db, {
    brief: "a project",
    runtime: "claude",
  });
  d.db.run("update agent set session = 'ses_kept' where id = ?", [kept]);
  const asked: string[] = [];
  const block = (r: string) => {
    asked.push(r);
    return d.runtimes[r]?.block() ?? Promise.resolve(undefined);
  };
  const a = agentOf(d.db, fresh);
  expect(a && (await runnableAgentOf(d, a, block))).toMatchObject({
    model: null,
    runtime: "pi",
  });
  expect(agentOf(d.db, fresh)).toMatchObject({ model: null, runtime: "pi" });
  // Already on pi: nothing asked again.
  const after = agentOf(d.db, fresh);
  asked.length = 0;
  expect(after && (await runnableAgentOf(d, after, block))).toBe(after);
  expect(asked).toEqual([]);
  // A session can't change runtime: it stays, blocked.
  const k = agentOf(d.db, kept);
  expect(k && (await runnableAgentOf(d, k))).toBe(k);
  // pi can't run either: nothing gained, it stays, and a start says both.
  pi.blocked = "pi needs OPENROUTER_API_KEY";
  const { id: other } = insertAgent(d.db, {
    brief: "another",
    runtime: "claude",
  });
  const o = agentOf(d.db, other);
  expect(o && (await runnableAgentOf(d, o))).toBe(o);
  expect(await startBlockOf(d, "claude")).toBe(
    "claude is not signed in; pi: pi needs OPENROUTER_API_KEY"
  );
});
