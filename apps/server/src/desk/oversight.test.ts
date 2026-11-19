import { afterAll, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clock, MIN } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { DESK_AGENT_FOLDERS, DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { ask } from "../host/asks";
import { changeRegisteredAgent } from "../host/change-registered-agent";
import { requested } from "../host/change-todo-item";
import { agentChangeOf, agentOf, agentsNow, modelOf } from "../host/desk-read";
import {
  agentLinesOnProjects,
  readActiveAgentOf,
  readAgentRows,
  readAgentsOnSteps,
  readRegisteredAgents,
} from "../host/registered-agents";
import { deskCard } from "../host/status/desk-card";
import { CORRECTIONS } from "../memory/memory-files";
import { readPeople } from "../memory/who";
import type { AgentChange } from "../records/registered-agent";
import { readPacket } from "./agent-actions";
import { applyAgentChanges } from "./agent-changes";
import { type Desk, openDesk, postReportLine } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { ticking } from "./test-ticker";

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
  setSystemTime();
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  // A start on a matter saves its goal.
  rmSync(CORRECTIONS, { force: true });
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
const people = await readPeople();

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
    (await applied({ action: "start", folder: "/nowhere", steps: ["x"] }))
      ?.error
  ).toStartWith("the folder its sessions start in must be absolute");
  // No folder: one of its own, under the desk's state.
  const own = (await applied({ action: "start", steps: ["obs_00000000a1ff"] }))
    ?.agent_id as string;
  expect(agentOf(desk.db, own)?.folder).toBe(join(DESK_AGENT_FOLDERS, own));
  expect(existsSync(join(DESK_AGENT_FOLDERS, own))).toBe(true);
  await applied({ action: "stop", agent: own });
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
  // An agent handed over to a newer one is over: it cannot be resumed.
  desk.db.run("update agent set status = 'handed_over' where id = ?", [agent]);
  expect((await applied({ action: "resume", agent }))?.error).toBe(
    `${agent} is handed_over`
  );
  desk.db.run("update agent set status = 'active' where id = ?", [agent]);
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
      areas: [],
      goal: {
        at: "2026-11-18T02:00:00.000Z",
        by: "owner",
        text: "The cake is collected",
      },
      id: "matter_00000000a001",
      name: "Test bakery order",
      nextStep: {
        at: "2026-11-18T02:00:00.000Z",
        by: "life",
        kind: "do",
        text: "Ask the bakery for the pickup day",
      },
      owedTo: [],
      projects: [],
      status: "moving",
      steps: [
        {
          day: "2026-11-17",
          kind: "to_do",
          quote: "",
          ref: STEP,
          text: "Order the cake",
        },
      ],
      waitingOn: [],
      with: [],
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

    expect(
      readAgentsOnSteps([STEP, "obs_00000000a999"], [], people)[0]
    ).toMatchObject({
      id: onMatter?.id,
      status: "waiting",
    });
    expect(agentLinesOnProjects(["test-shop"])[0]).toContain(
      "amber: default wait"
    );
    expect(readActiveAgentOf()([STEP], [])).toBe(onMatter?.id);
    const worker = project ?? "";
    const own = onMatter?.id ?? "";
    // A matter of a project with an active worker carries it; its own agent wins; another project's matter has none.
    expect(readActiveAgentOf()(["obs_00000000a999"], ["test-shop"])).toBe(
      worker
    );
    expect(readActiveAgentOf()([STEP], ["test-shop"])).toBe(own);
    expect(readActiveAgentOf()(["obs_00000000a999"], ["test-farm"])).toBe(
      undefined
    );
    expect(
      readAgentsOnSteps([STEP], ["test-shop"], people).map((a) => a.id)
    ).toEqual([own, worker]);
    // A stopped worker holds the project for the desk, but works on nothing: no row carries it.
    desk.db.run("update agent set status = 'stopped' where id = ?", [worker]);
    expect(
      readActiveAgentOf()(["obs_00000000a999"], ["test-shop"])
    ).toBeUndefined();
    expect(
      readAgentsOnSteps([STEP], ["test-shop"], people).map((a) => a.id)
    ).toEqual([own]);
    desk.db.run("update agent set status = 'active' where id = ?", [worker]);
    // A matter of two projects, each with an active worker, gets the first project's.
    const farm =
      (await applied({ action: "start", folder, project: "test-farm" }))
        ?.agent_id ?? "";
    const gone = ["obs_00000000a999"];
    expect(readActiveAgentOf()(gone, ["test-farm", "test-shop"])).toBe(farm);
    expect(readActiveAgentOf()(gone, ["test-shop", "test-farm"])).toBe(worker);
    desk.db.run("update agent set status = 'stopped' where id = ?", [farm]);
    // Its packet opens with its matter as read now: its goal and next step first.
    expect(
      JSON.parse(
        (await readPacket(desk, onMatter?.id ?? "", true)).split("\n")[1] ?? ""
      )
    ).toMatchObject({
      goal: { text: "The cake is collected" },
      id: "matter_00000000a001",
      name: "Test bakery order",
      nextStep: {
        by: "life",
        kind: "do",
        text: "Ask the bakery for the pickup day",
      },
      status: "moving",
    });
    expect(readActiveAgentOf()(["obs_00000000a999"], [])).toBeUndefined();

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
    await stopTicking?.();
    book.mockRestore();
  }
});

test("the desk off breaks no read: each says so, and his word is refused", async () => {
  setSettings({ desk: null });
  expect((await readRegisteredAgents()).desk).toBe("off");
  expect(await readAgentRows(clock().toISOString())).toEqual([]);
  expect(readAgentsOnSteps([STEP], [], people)).toEqual([]);
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

/** What a matter read holds besides its id, name, status and steps: nobody, nothing open. */
const NO_ONE = {
  areas: [],
  lone: false,
  open: true,
  openSteps: [],
  owedTo: [],
  projects: [],
  waitingOn: [],
  with: [],
};

/** Stops the desk ticking (his word may be recorded after a slow first read, so a test keeps it ticking). */
let stopTicking: (() => Promise<void>) | undefined;

test("change_registered_agent records his word and answers with what the desk did", async () => {
  setSettings({ desk: { runtimes: {} } });
  const matters = await import("../memory/matters");
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    {
      ...NO_ONE,
      id: "matter_00000000a002",
      name: "Test repair",
      status: "moving",
      steps: [{ ref: "obs_00000000a201" }, { ref: "obs_00000000a202" }],
    },
    {
      ...NO_ONE,
      id: "matter_00000000a003",
      name: "Test shop sign",
      projects: ["test-shop"],
      status: "moving",
      steps: [{ ref: "obs_00000000a301" }],
    },
  ] as never);
  const readTruth = await import("../memory/read-truth");
  const made = await readTruth.loadTruth();
  const truth = spyOn(readTruth, "loadTruth").mockResolvedValue({
    ...made,
    projects: [
      ...made.projects,
      {
        chats: [],
        id: "test-shop",
        name: "Test shop",
        people: [],
        repos: ["test-shop-site"],
      },
    ],
  } as never);
  const repos = spyOn(
    await import("../sources/git"),
    "listRepos"
  ).mockReturnValue([{ key: "test-shop-site", path: folder }]);
  try {
    await expect(
      changeRegisteredAgent({
        action: "start",
        folder,
        project: "no-such",
        said: "Test",
      })
    ).rejects.toThrow("no project no-such");
    stopTicking = ticking(desk);
    const done = await changeRegisteredAgent({
      action: "start",
      folder,
      runtime: "claude",
      said: "Test: work on the repair",
      step: "obs_00000000a202",
    });
    expect(done).toMatchObject({ action: "start", state: "started" });
    const id = (done as { agent: string }).agent;
    // Anchored on the step he named first, then the rest of its matter.
    expect(
      desk.db
        .query<{ step: string }, [string]>(
          "select step from anchor where agent_id = ? order by rowid"
        )
        .all(id)
        .map((s) => s.step)
    ).toEqual(["obs_00000000a202", "obs_00000000a201"]);
    await expect(
      changeRegisteredAgent({
        action: "resume",
        agent: id as never,
        said: "Test: resume",
      })
    ).rejects.toThrow(`${id} is active`);
    // No folder named: its matter's project's repo, when it is on the Mac; his words are its brief.
    const sign = (
      await changeRegisteredAgent({
        action: "start",
        runtime: "claude",
        said: "The shop sign is up by Friday",
        step: "matter_00000000a003",
      })
    ).agent;
    expect(agentOf(desk.db, sign ?? "")).toMatchObject({
      brief: "The shop sign is up by Friday",
      folder,
    });
    // A project with no folder named: its repo too.
    const shop = (
      await changeRegisteredAgent({
        action: "start",
        project: "test-shop",
        runtime: "claude",
        said: "Keep the shop's site up to date",
      })
    ).agent;
    expect(agentOf(desk.db, shop ?? "")?.folder).toBe(folder);
    // The same start again (a retried call): the same agent, not a second one on the project.
    const again = await changeRegisteredAgent({
      action: "start",
      project: "test-shop",
      runtime: "claude",
      said: "Keep the shop's site up to date",
    });
    expect(again.agent).toBe(shop);
  } finally {
    await stopTicking?.();
    book.mockRestore();
    truth.mockRestore();
    repos.mockRestore();
  }
}, 30_000);

test("a start hands over the stopped agents on its subject at once; a pause beside another, a re-point or a repeat does not", async () => {
  const start = (subject: Partial<AgentChange>) =>
    applied({
      action: "start",
      folder,
      runtime: "claude",
      ...subject,
    } as AgentChange);
  const stopAt = async (id: string) => {
    await applied({ action: "stop", agent: id });
    return agentOf(desk.db, id);
  };
  setSystemTime(new Date(clock().getTime()));
  // He stops A, then starts B on its project: A is replaced, no tick needed.
  const a = (await start({ project: "test-hand" }))?.agent_id ?? "";
  expect((await stopAt(a))?.stopped_at).toBe(clock().toISOString());
  const b = (await start({ project: "test-hand" }))?.agent_id ?? "";
  expect(agentOf(desk.db, a)).toMatchObject({
    outcome: `replaced by ${b}`,
    status: "handed_over",
  });
  // A matter: the same, through its step.
  const m = (await start({ steps: ["obs_00000000a2a1"] }))?.agent_id ?? "";
  await stopAt(m);
  const n2 = (await start({ steps: ["obs_00000000a2a1"] }))?.agent_id ?? "";
  expect(agentOf(desk.db, m)?.outcome).toBe(`replaced by ${n2}`);
  // A stopped agent re-pointed onto a project with an active agent stays stopped.
  const c = (await start({ project: "test-other" }))?.agent_id ?? "";
  await stopAt(c);
  await applied({ action: "re_point", agent: c, project: "test-hand" });
  expect(agentOf(desk.db, c)?.status).toBe("stopped");
  // A start that returns the existing agent (an active one, same words) hands nothing over.
  const d = (await start({ project: "test-repeat" }))?.agent_id ?? "";
  const e = (await start({ project: "test-repeat" }))?.agent_id ?? "";
  await stopAt(e);
  desk.db.run("update agent set brief = ? where id = ?", [
    `Test: change ${n + 1}`,
    d,
  ]);
  expect((await start({ project: "test-repeat" }))?.agent_id).toBe(d);
  expect(agentOf(desk.db, e)?.status).toBe("stopped");
  // Resume clears the stop time; the agent reads give it as `statusSince` while stopped.
  expect((await applied({ action: "resume", agent: c }))?.error).toBeNull();
  expect(agentOf(desk.db, c)?.stopped_at).toBeNull();
  await stopAt(c);
  expect(
    agentsNow(desk.db, clock().getTime()).find((x) => x.id === c)?.statusSince
  ).toBe(clock().toISOString());
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
  expect(readAgentsOnSteps([STEP], [], people)).toEqual([]);
  expect(deskCard(clock().getTime())).toMatchObject({
    tone: "bad",
    word: "unreadable",
  });
});
