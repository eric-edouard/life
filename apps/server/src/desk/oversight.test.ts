import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clock, MIN } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { ask } from "../host/asks";
import { changeRegisteredAgent } from "../host/change-registered-agent";
import { requested } from "../host/change-todo-item";
import { agentChangeOf, agentOf, modelOf } from "../host/desk-read";
import {
  agentLinesOnProjects,
  agentLinesOnSteps,
  readAgentMarks,
  readAgentRows,
  readRegisteredAgents,
} from "../host/registered-agents";
import { deskCard } from "../host/status/desk-card";
import type { AgentChange } from "../records/registered-agent";
import { applyAgentChanges } from "./agent-changes";
import { type Desk, openDesk, postReportLine } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// Oversight (the desk spec, step 4): his word about his agents applied by the desk, and what host reads of them, from
// a made-up store at the desk's own path. Made-up agents, matters and folders.

const folder = mkdtempSync(join(tmpdir(), "life-oversight-"));
rmSync(dirname(DESK_STORE), { force: true, recursive: true });
setSettings({
  desk: {
    defaultRuntime: "claude",
    runtimes: { claude: { model: "test-model" } },
  },
});
const desk: Desk = {
  db: openDesk(),
  runtimes: { claude: fakeRuntime().runtime },
};

afterAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  setSettings({ desk: null });
});

/** His word, recorded as the connector records it (an ask of the desk), `ago` ms before now; its ask id. */
let n = 0;
const said = (change: AgentChange | null, ago = 0) => {
  n += 1;
  return ask(
    requested(
      "connector",
      `Test: change ${n}`,
      new Date(clock().getTime() - ago - n * 1000).toISOString()
    ),
    {
      agent: DESK_AGENT,
      confidence: "high",
      ...(change ? { agentChange: change } : {}),
    },
    "connector",
    "asked in a chat",
    clock().getTime() - ago
  ).id;
};

/** Records his word, lets the desk apply it, and returns what it did. */
async function applied(change: AgentChange | null, ago = 0) {
  const id = said(change, ago);
  await applyAgentChanges(desk);
  return agentChangeOf(desk.db, id);
}

const STEP = "obs_00000000a101";

/** The agent the first test starts; the next one changes it. */
let agent = "";

test("his word starts an agent on a matter, with the desk's default runtime and model; a bad start is refused, saying why", async () => {
  const started = await applied({ action: "start", folder, steps: [STEP] });
  agent = started?.agent_id ?? "";
  expect(started?.error).toBeNull();
  const a = agentOf(desk.db, agent);
  expect(a?.status).toBe("active");
  expect(a?.brief).toStartWith("Test: change");
  // The runtime's default model, from the desk's settings, until his word changes it.
  expect(a && modelOf(a)).toEqual({ effort: null, model: "test-model" });

  expect(
    (await applied({ action: "start", folder, steps: [STEP] }))?.error
  ).toBe(`that matter is already held by ${agent}`);
  expect(
    (
      await applied({
        action: "start",
        folder,
        project: "test-shop",
        steps: [STEP],
      })
    )?.error
  ).toStartWith("name exactly one subject");
  expect(
    (await applied({ action: "start", steps: [STEP] }))?.error
  ).toStartWith("name the folder");
  expect(
    (await applied({ action: "start", folder, runtime: "nope", steps: ["x"] }))
      ?.error
  ).toStartWith("name a runtime");
});

test("his word stops, resumes, re-points and changes the model of an agent, each applied once; a handover, a spoken or a stale ask is refused", async () => {
  await applied({
    action: "change_model",
    agent,
    effort: "high",
    model: "other",
  });
  const changed = agentOf(desk.db, agent);
  expect(changed && modelOf(changed)).toEqual({
    effort: "high",
    model: "other",
  });

  expect((await applied({ action: "resume", agent }))?.error).toBe(
    `${agent} is active`
  );
  await applied({ action: "stop", agent });
  expect(agentOf(desk.db, agent)?.status).toBe("stopped");
  await applied({ action: "re_point", agent, project: "test-shop" });
  expect(agentOf(desk.db, agent)?.project).toBe("test-shop");
  await applied({ action: "resume", agent });
  expect(agentOf(desk.db, agent)?.status).toBe("active");
  await applied({ action: "re_point", agent, steps: [STEP] });
  expect(agentOf(desk.db, agent)?.project).toBeNull();

  expect((await applied({ action: "hand_over", agent }))?.error).toBe(
    "a handover comes with the desk's next step"
  );
  // A spoken ask (no change yet) and a stale one are refused, not applied late.
  expect((await applied(null))?.error).toStartWith("only a change");
  expect(
    (await applied({ action: "stop", agent }, 11 * MIN))?.error
  ).toStartWith("asked over 10 minutes");
  expect(agentOf(desk.db, agent)?.status).toBe("active");

  // Applied once: reading again starts nothing new.
  const count = () =>
    desk.db.query<{ n: number }, []>("select count(*) as n from agent").get()
      ?.n;
  const before = count();
  desk.db.run("delete from cursor where name = 'asks'");
  await applyAgentChanges(desk);
  expect(count()).toBe(before);
});

test("what his agents are doing: each with its matter, status, wait, link and amber; the matter's, project's and report's parts", async () => {
  const matters = await import("../memory/matters");
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    {
      id: "matter_00000000a001",
      name: "Test bakery order",
      status: "moving",
      steps: [{ ref: STEP }],
    },
  ] as never);
  try {
    const project = (
      await applied({ action: "start", folder, project: "test-shop" })
    )?.agent_id;
    desk.db.run(
      "update agent set wait_is_default = 1, link = 'fake://p' where id = ?",
      [project ?? ""]
    );
    const r = await readRegisteredAgents();
    expect(r.desk).toBe("ok");
    // His changes the desk refused show, with why.
    expect(r.refused.map((x) => x.error)).toContain(
      "a handover comes with the desk's next step"
    );
    expect(r.helper).toBe("not running");
    const onMatter = r.agents.find((a) => a.steps[0] === STEP);
    expect(onMatter).toMatchObject({
      matter: { id: "matter_00000000a001", name: "Test bakery order" },
      model: "other",
      status: "waiting",
    });
    expect(r.agents.find((a) => a.id === project)).toMatchObject({
      amber: ["default wait"],
      link: "fake://p",
      project: "test-shop",
    });

    expect(agentLinesOnSteps([STEP, "obs_00000000a999"])[0]).toStartWith(
      `- ${onMatter?.id} [waiting]`
    );
    expect(agentLinesOnProjects(["test-shop"])[0]).toContain(
      "amber: default wait"
    );
    expect(readAgentMarks()([STEP])).toBe(`agent ${onMatter?.id}`);
    expect(readAgentMarks()(["obs_00000000a999"])).toBe("");

    const since = new Date(clock().getTime() - MIN).toISOString();
    postReportLine(desk.db, {
      day: "2026-11-18",
      line: "Test plan ready",
      link: "https://example.com/plan",
      source: "test-plan",
    });
    const rows = await readAgentRows(since);
    expect(rows).toContainEqual({
      name: "test-plan · 2026-11-18",
      relation: "Test plan ready · https://example.com/plan",
    });
    expect(rows.find((x) => x.name.startsWith(`${onMatter?.id} `))?.name).toBe(
      `${onMatter?.id} [waiting] Test bakery order`
    );
    // The desk's helper is not running: the card says so, red.
    expect(deskCard(clock().getTime())).toMatchObject({
      tone: "bad",
      word: "not running",
    });
  } finally {
    book.mockRestore();
  }
});

test("the desk off breaks no read: each says so, and his word is refused", async () => {
  setSettings({ desk: null });
  expect((await readRegisteredAgents()).desk).toBe("off");
  expect(await readAgentRows(clock().toISOString())).toEqual([]);
  expect(agentLinesOnSteps([STEP])).toEqual([]);
  expect(deskCard(clock().getTime())).toMatchObject({
    tone: "idle",
    word: "off",
  });
  await expect(
    changeRegisteredAgent({
      action: "stop",
      agent: "agt_000000000001",
      said: "Test: stop",
    })
  ).rejects.toThrow("Not done:");
});

test("change_registered_agent records his word and answers with what the desk did", async () => {
  setSettings({ desk: { runtimes: {} } });
  const matters = await import("../memory/matters");
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    {
      id: "matter_00000000a002",
      name: "Test repair",
      status: "moving",
      steps: [{ ref: "obs_00000000a201" }, { ref: "obs_00000000a202" }],
    },
  ] as never);
  try {
    await expect(
      changeRegisteredAgent({
        action: "start",
        folder,
        project: "no-such",
        said: "Test",
      })
    ).rejects.toThrow("no project no-such");
    setTimeout(() => applyAgentChanges(desk), 300);
    const done = await changeRegisteredAgent({
      action: "start",
      folder,
      runtime: "claude",
      said: "Test: work on the repair",
      step: "obs_00000000a202",
    });
    expect(done).toStartWith("Done: start agt_");
    const id = done.split(" ").at(-1) ?? "";
    // Anchored on the step he named first, then the rest of its matter.
    expect(
      desk.db
        .query<{ step: string }, [string]>(
          "select step from anchor where agent_id = ? order by rowid"
        )
        .all(id)
        .map((s) => s.step)
    ).toEqual(["obs_00000000a202", "obs_00000000a201"]);
    setTimeout(() => applyAgentChanges(desk), 300);
    await expect(
      changeRegisteredAgent({
        action: "resume",
        agent: id as never,
        said: "Test: resume",
      })
    ).rejects.toThrow(`${id} is active`);
  } finally {
    book.mockRestore();
  }
});

test("its store unreadable, the reads say so and the report still has its section", async () => {
  desk.db.close();
  for (const f of ["", "-wal", "-shm"]) {
    rmSync(`${DESK_STORE}${f}`, { force: true });
  }
  writeFileSync(DESK_STORE, "not a store");
  const r = await readRegisteredAgents();
  expect(r.desk).toBe("unreadable");
  expect(await readAgentRows(clock().toISOString())).toEqual([
    { name: "Desk", relation: "its store could not be read" },
  ]);
  expect(agentLinesOnSteps([STEP])).toEqual([
    "The desk's store could not be read.",
  ]);
  expect(deskCard(clock().getTime())).toMatchObject({
    tone: "bad",
    word: "unreadable",
  });
});
