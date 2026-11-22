import { afterAll, beforeAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { agentInRole } from "../host/desk-read";
import { type Desk, openDesk } from "./desk-store";
import { roleAssignmentOf, roleStartBlockOf } from "./role-agents";
import { fakeRuntime } from "./runtimes/fake-runtime";

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

test("a role takes its own runtime from the settings, a role left out the desk's default", async () => {
  expect(await roleStartBlockOf(desk, "caretaker", () => "")).toBe(
    "no runtime the desk drives"
  );
  expect(await roleStartBlockOf(desk, "personal", () => "")).toBeUndefined();
  desk.runtimes.claude = fakeRuntime().runtime;
  roleAssignmentOf(desk, "caretaker", "fix what went wrong", undefined);
  roleAssignmentOf(desk, "personal", "take his asks", undefined);
  expect(agentInRole(desk.db, "caretaker")?.runtime).toBe("claude");
  expect(agentInRole(desk.db, "personal")?.runtime).toBe("pi");
});
