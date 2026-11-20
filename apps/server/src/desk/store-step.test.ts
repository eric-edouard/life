import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { APP_FOLDERS } from "../core/platform";
import { gitOut } from "../core/proc";
import {
  agentOf,
  agentWaitOf,
  anchorsOf,
  currentAssignmentOf,
  heldByAgents,
  isOldShape,
  NOT_MIGRATED,
} from "../host/desk-read";
import { AgentWait } from "../records/registered-agent";
import { openDesk, SCHEMA } from "./desk-store";
import { stepRoles, stepStore } from "./store-step";

// The desk's store step (agents and matters, PR 1) on a made-up store of the old shape: same agents, each wait, anchor,
// event, turn and note found on its assignment, the holds unchanged; run twice; refused, rolled back, or skipped.

const OLD = `
create table agent (id text primary key, brief text not null, runtime text not null, folder text not null, project text, model text, effort text, session text, link text, status text not null, wait_events text not null default '[]', wait_until text, wait_reason text, wait_is_default integer not null default 0, notes text not null default '', created_at text not null, ended_at text, outcome text, why_not_started text, stopped_at text, is_handed_out integer not null default 0, check (status <> 'active' or wait_until is not null));
create table session (agent_id text not null, runtime text not null, ref text not null, link text not null, started_at text not null, ended_at text, why_ended text, context_at_first_call integer);
create table event (agent_id text not null, event_id text not null, name text not null, payload text not null, received_at text not null, handed integer not null default 0, consumed_at text, dropped_at text, unique (agent_id, event_id));
create table turn (id integer primary key, agent_id text not null, session text, cause text not null, started_at text not null, begun_at text, heard_at text, reminded_at text, ended_at text, outcome text, tokens_in integer, tokens_cached integer, tokens_out integer, context_used integer);
create index turn_by_agent on turn (agent_id, id);
create table cursor (name text primary key, value text not null);
create table anchor (agent_id text not null, step text not null, added_at text not null, primary key (agent_id, step));
create index anchor_by_step on anchor (step);
create index event_dropped on event (agent_id, dropped_at) where dropped_at is not null;
`;
const T = "2026-11-18T09:00:00.000Z";
const BACKUP_FILE = /^desk-before-assignments-.*\.sqlite$/;
const ROLES_BACKUP_FILE = /^desk-before-roles-.*\.sqlite$/;
const WAIT = JSON.stringify([{ chat: "Test Ana" }]);

/** A made-up store of the old shape, and an agents repo (a git repo) with the project agents' homes. */
function oldDesk() {
  const dir = mkdtempSync(join(tmpdir(), "life-step-"));
  const repo = join(dir, "agents");
  for (const home of ["project-test-house", "personal"]) {
    mkdirSync(join(repo, home), { recursive: true });
  }
  gitOut(repo, ["init", "-q"]);
  gitOut(repo, ["config", "user.email", "test@example.com"]);
  gitOut(repo, ["config", "user.name", "Test"]);
  const path = join(dir, "desk.sqlite");
  const db = new Database(path);
  db.run(OLD);
  const agent = (
    id: string,
    o: Partial<Record<string, string | number | null>>
  ) =>
    db.run(
      "insert into agent (id, brief, runtime, folder, project, status, wait_events, wait_until, wait_reason, notes, created_at, ended_at, outcome, why_not_started, is_handed_out) values (?, 'Test brief', 'fake', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        id,
        o.folder ?? dir,
        o.project ?? null,
        o.status ?? "active",
        o.wait_events ?? "[]",
        o.wait_until ?? null,
        o.wait_reason ?? null,
        o.notes ?? "",
        T,
        o.ended_at ?? null,
        o.outcome ?? null,
        o.why_not_started ?? null,
        o.is_handed_out ?? 0,
      ]
    );
  agent("agt_000000000001", {
    notes: "Test notes: the house's people",
    project: "test-house",
    wait_until: "2026-11-19T09:00:00.000Z",
  });
  agent("agt_000000000002", {
    is_handed_out: 1,
    notes: "Test notes: waiting on Ana",
    wait_events: WAIT,
    wait_reason: "Ana's reply",
    wait_until: "2026-11-18T12:00:00.000Z",
  });
  agent("agt_000000000003", {
    ended_at: "2026-11-18T10:00:00.000Z",
    is_handed_out: 1,
    status: "ended",
    why_not_started: "it did not begin",
  });
  agent("agt_000000000004", {
    folder: join(repo, "personal"),
    project: "test-admin",
    status: "stopped",
    wait_until: T,
  });
  for (const [id, step] of [
    ["agt_000000000002", "obs_test_a"],
    ["agt_000000000002", "obs_test_b"],
    ["agt_000000000003", "obs_test_c"],
  ]) {
    db.run("insert into anchor (agent_id, step, added_at) values (?, ?, ?)", [
      id as string,
      step as string,
      T,
    ]);
  }
  db.run(
    "insert into event (agent_id, event_id, name, payload, received_at) values ('agt_000000000002', 'whatsapp:m1', 'message.received', '{}', ?)",
    [T]
  );
  db.run(
    "insert into turn (agent_id, cause, started_at, begun_at, ended_at, outcome) values ('agt_000000000002', 'first turn', ?, ?, ?, 'waited')",
    [T, T, T]
  );
  db.run(
    "insert into session (agent_id, runtime, ref, link, started_at) values ('agt_000000000002', 'fake', 's1', 'l1', ?)",
    [T]
  );
  db.close();
  return { dir, path, repo };
}

/** What the old code's hold rows were, by its own query, in the new names. */
const oldHolds = (path: string) =>
  new Database(path, { readonly: true })
    .query<Record<string, string | number | null>, [string]>(
      `select a.id as agent, a.ended_at as closedAt, a.is_handed_out, a.outcome, a.project as project, a.status, n.step, a.why_not_started as whyNotStarted from anchor n join agent a on a.id = n.agent_id where a.ended_at is null or a.ended_at >= ?1
      union all select a.id, a.ended_at, a.is_handed_out, a.outcome, a.project, a.status, null, a.why_not_started from agent a where a.project is not null and (a.ended_at is null or a.ended_at >= ?1)`
    )
    .all("2000-01-01")
    .map(({ is_handed_out, ...h }) => ({
      ...h,
      openedBy: is_handed_out === 1 ? "desk" : "owner",
    }));

test("the step carries every agent to its assignment: waits, anchors, events, turns and notes, the holds unchanged; a second run leaves it be", () => {
  const { dir, path, repo } = oldDesk();
  const holds = oldHolds(path);
  expect(stepStore(path, dir, repo)).toBe("migrated");
  expect(stepStore(path, dir, repo)).toBe("in shape");
  expect(readdirSync(dir).some((f) => f.startsWith("desk-before-"))).toBe(true);
  const db = openDesk(path);
  const count = (t: string) =>
    db.query<{ n: number }, []>(`select count(*) as n from ${t}`).get()?.n;
  expect([
    count("agent"),
    count("assignment"),
    count("anchor"),
    count("event"),
    count("turn"),
    count("session"),
  ]).toEqual([4, 4, 3, 1, 1, 1]);
  // A migrated wait with no reason still reads as a wait an agent can send back to set_wait.
  const noReason = currentAssignmentOf(db, "agt_000000000001");
  const a1 = agentOf(db, "agt_000000000001");
  const { isDefault, ...held } =
    (a1 && noReason && agentWaitOf(a1, noReason)) || {};
  expect(AgentWait.safeParse(held).success).toBe(true);
  const s = currentAssignmentOf(db, "agt_000000000002");
  expect(s).toMatchObject({
    closed_at: null,
    opened_at: T,
    opened_by: "desk",
    wait_events: WAIT,
    wait_reason: "Ana's reply",
    wait_until: "2026-11-18T12:00:00.000Z",
  });
  expect(anchorsOf(db, s?.id ?? "")).toEqual(["obs_test_a", "obs_test_b"]);
  expect(readFileSync(s?.notes_path ?? "", "utf8")).toBe(
    "Test notes: waiting on Ana"
  );
  expect(
    db
      .query(
        "select assignment_id from event union all select assignment_id from turn"
      )
      .all()
  ).toEqual([{ assignment_id: s?.id }, { assignment_id: s?.id }]);
  expect(currentAssignmentOf(db, "agt_000000000003")).toMatchObject({
    closed_at: "2026-11-18T10:00:00.000Z",
    why_not_started: "it did not begin",
  });
  // A stopped agent's assignment stays open, due at its old deadline.
  expect(currentAssignmentOf(db, "agt_000000000004")).toMatchObject({
    closed_at: null,
    wait_until: T,
  });
  expect(heldByAgents(db)).toEqual(
    expect.arrayContaining(holds.map((h) => expect.objectContaining(h)))
  );
  expect(heldByAgents(db)).toHaveLength(holds.length);
  expect(gitOut(repo, ["log", "--format=%s"])).toBe(
    "desk: each agent's notes as its assignment's file"
  );
  db.close();
});

test("a step that fails leaves the old store, refused by openDesk; two failed starts then a success keep one copy and commit only its notes", () => {
  const { dir, path, repo } = oldDesk();
  const unrelated = join(repo, "assignments", "unrelated", "NOTES.md");
  mkdirSync(dirname(unrelated), { recursive: true });
  writeFileSync(unrelated, "Test: someone else's work");
  // Its repo gone for two starts: the notes cannot be committed.
  renameSync(join(repo, ".git"), join(dir, "git-aside"));
  for (const _ of [1, 2]) {
    expect(() => stepStore(path, dir, repo)).toThrow("git add");
    expect(() => openDesk(path)).toThrow(NOT_MIGRATED);
  }
  const db = new Database(path, { readonly: true });
  expect(isOldShape(db)).toBe(true);
  expect(db.query("select count(*) as n from agent").get()).toEqual({ n: 4 });
  db.close();
  renameSync(join(dir, "git-aside"), join(repo, ".git"));
  expect(stepStore(path, dir, repo)).toBe("migrated");
  expect(readdirSync(dir).filter((f) => f.startsWith("desk-before-"))).toEqual([
    expect.stringMatching(BACKUP_FILE),
  ]);
  expect(gitOut(repo, ["status", "--porcelain"])).toBe(
    "?? assignments/unrelated/"
  );
  expect(readFileSync(unrelated, "utf8")).toBe("Test: someone else's work");
});

test("a store from before the late columns (begun_at, context_used, why_not_started…) migrates with their old backfills", () => {
  const { dir, path, repo } = oldDesk();
  const db = new Database(path);
  db.run("drop index turn_by_agent");
  for (const [table, column] of [
    ["turn", "begun_at"],
    ["turn", "context_used"],
    ["agent", "why_not_started"],
    ["agent", "stopped_at"],
    ["agent", "is_handed_out"],
    ["session", "context_at_first_call"],
  ]) {
    db.run(`alter table ${table} drop column ${column}`);
  }
  db.run(
    "update agent set outcome = 'not started: it did not begin' where id = 'agt_000000000003'"
  );
  db.close();
  expect(stepStore(path, dir, repo)).toBe("migrated");
  const after = openDesk(path);
  expect(currentAssignmentOf(after, "agt_000000000003")).toMatchObject({
    opened_by: "owner",
    outcome: null,
    why_not_started: "it did not begin",
  });
  expect(after.query("select begun_at, context_used from turn").all()).toEqual([
    { begun_at: T, context_used: null },
  ]);
  after.close();
});

test("the step is refused without an agents repo, or with a project agent's home missing, naming it; skipped on the app's state", () => {
  const { dir, path, repo } = oldDesk();
  expect(() => stepStore(path, dir, undefined)).toThrow(
    "desk.agentsRepo is not set"
  );
  const bare = mkdtempSync(join(tmpdir(), "life-step-"));
  expect(() => stepStore(path, dir, bare)).toThrow(
    `agt_000000000001's home ${join(bare, "project-test-house")}`
  );
  expect(existsSync(join(bare, "assignments"))).toBe(false);
  expect(stepStore(path, APP_FOLDERS.state, repo)).toBe("skipped");
  const db = new Database(path, { readonly: true });
  expect(isOldShape(db)).toBe(true);
  db.close();
});

test("a store from before roles is refused by openDesk; the roles step carries the Personal flag into `role` behind its own copy, once, and one agent per role stands", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-step-"));
  const path = join(dir, "desk.sqlite");
  const db = new Database(path);
  db.run(
    SCHEMA.replace(
      "role text check (role in ('personal', 'caretaker')),",
      "is_personal integer not null default 0,"
    ).replace(
      "one_agent_per_role on agent (role) where role is not null",
      "one_personal_agent on agent (is_personal) where is_personal = 1"
    )
  );
  for (const [id, personal] of [
    ["agt_000000000001", 1],
    ["agt_000000000002", 0],
  ] as const) {
    db.run(
      "insert into agent (id, brief, runtime, folder, status, is_personal, created_at) values (?, 'Test brief', 'claude', '/tmp', 'active', ?, ?)",
      [id, personal, T]
    );
  }
  db.close();
  expect(() => openDesk(path)).toThrow(NOT_MIGRATED);
  expect(stepRoles(path, dir)).toBe("migrated");
  expect(stepRoles(path, dir)).toBe("in shape");
  expect(readdirSync(dir).filter((f) => f.startsWith("desk-before-"))).toEqual([
    expect.stringMatching(ROLES_BACKUP_FILE),
  ]);
  const after = openDesk(path);
  expect(after.query("select id, role from agent order by id").all()).toEqual([
    { id: "agt_000000000001", role: "personal" },
    { id: "agt_000000000002", role: null },
  ]);
  expect(() =>
    after.run("update agent set role = 'personal' where id = ?", [
      "agt_000000000002",
    ])
  ).toThrow("UNIQUE");
  after.close();
});
