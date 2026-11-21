import { afterAll, expect, spyOn, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { DESK_AGENT } from "../core/names";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { asksFor } from "../host/asks";
import { changeRegisteredAgent } from "../host/change-registered-agent";
import { agentOf, openAssignmentOfMatter } from "../host/desk-read";
import { readRegisteredAgents } from "../host/registered-agents";
import { CORRECTIONS } from "../memory/memory-files";
import { register } from "./agent-actions";
import { start } from "./agent-changes";
import { readPeopleOnce } from "./desk-clock";
import { type Desk, openDesk, saveCursor } from "./desk-store";
import { foldAssignments } from "./matter-net";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { matterView, withMatters } from "./test-desk";
import { ticking } from "./test-ticker";

// The matter he chose (life#826), kept on its assignment (`matter_id`): a made-up store at the desk's own path, where
// the connector reads it, and two made-up matters sharing one step.

rmSync(dirname(DESK_STORE), { force: true, recursive: true });
setSettings({
  desk: {
    defaultRuntime: "claude",
    runtimes: { claude: { model: "test-model" } },
  },
});
const desk: Desk = {
  db: openDesk(),
  embedder: null,
  runtimes: { claude: fakeRuntime().runtime },
};
// The ledger is shared by every test file of the run: this desk reads only the asks made from here on.
let page = asksFor(DESK_AGENT);
while (page.asks.length > 0) {
  page = asksFor(DESK_AGENT, page.cursor);
}
saveCursor(desk.db, "asks", page.cursor);

afterAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  // A start on a matter saves its goal.
  rmSync(CORRECTIONS, { force: true });
  setSettings({ desk: null });
});

// Regression (life#826): the desk found the matter again from its steps alone, so a Start on a matter sharing its one
// step with another went to the other matter's agent, and the fold moved it there again.
test("a Start on a matter sharing its step with another reaches its own project's agent, keeps that matter, and stays there through the fold", async () => {
  const projectOf = (id: string, name: string) => ({
    chats: [],
    deadlines: [],
    id,
    name,
    notes: "",
    people: [],
    repos: [],
    status: "active",
  });
  const readTruth = await import("../memory/read-truth");
  const made = await readTruth.loadTruth();
  const truth = spyOn(readTruth, "loadTruth").mockResolvedValue({
    ...made,
    projects: [
      ...made.projects,
      projectOf("test-garden", "Test garden"),
      projectOf("test-bakery", "Test bakery"),
    ],
  } as never);
  const garden = register(desk, {
    brief: "Test brief: the garden",
    project: "test-garden",
    runtime: "claude",
  });
  const bakery = register(desk, {
    brief: "Test brief: the bakery",
    project: "test-bakery",
    runtime: "claude",
  });
  const shared = "obs_00000000b826";
  const views = [
    {
      ...matterView("matter_00000000a826", [shared]),
      projects: ["test-garden"],
    },
    {
      ...matterView("matter_00000000b826", [shared]),
      projects: ["test-bakery"],
    },
  ];
  try {
    await withMatters(views, async () => {
      const stopTicking = ticking(desk);
      const done = await changeRegisteredAgent({
        action: "start",
        said: "Test: the bakery's oven",
        step: "matter_00000000b826",
      });
      await stopTicking();
      expect(done.agent).toBe(bakery);
      const s = openAssignmentOfMatter(desk.db, "matter_00000000b826");
      expect(s?.agent_id).toBe(bakery);
      // His agent list shows the matter he chose, not the other holder of its step.
      expect(
        (await readRegisteredAgents()).agents.find((a) => a.id === bakery)
          ?.matter?.id
      ).toBe("matter_00000000b826");
      expect(
        readFileSync(CORRECTIONS, "utf8").trim().split("\n").at(-1)
      ).toContain('"matter":"matter_00000000b826"');
      await foldAssignments(desk, readPeopleOnce());
      expect(
        openAssignmentOfMatter(desk.db, "matter_00000000b826")
      ).toMatchObject({ agent_id: bakery, id: s?.id });
      expect(agentOf(desk.db, garden)?.status).toBe("active");
      // Holding stays step-level (`holderOf`): the bakery's agent holds the shared step, so a Start on the other matter
      // answers with it, never a second agent on that step.
      expect(
        start(
          desk,
          { action: "start", matter: "matter_00000000a826", steps: [shared] },
          "Test: the garden's hedge",
          { taker: garden }
        )
      ).toEqual({ id: bakery });
    });
  } finally {
    truth.mockRestore();
  }
}, 30_000);
