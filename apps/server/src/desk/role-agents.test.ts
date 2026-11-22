import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { clock } from "../core/clock";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { agentInRole } from "../host/desk-read";
import { agentMoveReadOf } from "../host/move-read";
import { type Desk, openDesk } from "./desk-store";
import { roleAssignmentOf, roleStartBlockOf, standUp } from "./role-agents";
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
  expect(await roleStartBlockOf(desk, "caretaker", () => "")).toBe(
    "no runtime the desk drives"
  );
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
