import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { clock, DAY } from "../core/clock";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { agentsNow } from "../host/agents-now";
import {
  readAgentsOnSteps,
  readRegisteredAgents,
} from "../host/registered-agents";
import { DECISIONS } from "../memory/decision-lines";
import { requestDecision } from "../memory/decisions";
import { readPeople } from "../memory/who";
import type { EventFilter } from "../records/registered-agent";
import { register } from "./agent-actions";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { asgOf } from "./test-desk";

// What `readRegisteredAgents` adds from the desk's store: `wakesOn` while an agent waits, `statusSince` by status, the
// chat names of the agent's own events, its open card and its wide net. Made-up agents, chats and a card.

const DM = "33600000001@s.whatsapp.net";
const filter = (f: Partial<EventFilter>): EventFilter => ({
  from_me: false,
  ...f,
});

// Through the desk's store: statuses, the chat names of the agent's own events, the open card, the wide net.

const folder = mkdtempSync(join(tmpdir(), "life-wakes-on-"));
rmSync(dirname(DESK_STORE), { force: true, recursive: true });
setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
afterAll(() => {
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(DECISIONS, { force: true });
  setSettings({ desk: null });
});

test("an agent's read: wakesOn while it waits, [] otherwise, and statusSince by status", async () => {
  const desk: Desk = {
    db: openDesk(),
    runtimes: { claude: fakeRuntime().runtime },
  };
  const on = (id: string, filters: EventFilter[]) =>
    desk.db.run(
      "update assignment set wait_events = ?, wait_until = ? where agent_id = ?",
      [JSON.stringify(filters), "2026-11-25T09:00:00.000Z", id]
    );
  const turn = (id: string, endedAt: string | null) =>
    desk.db.run(
      "insert into turn (agent_id, assignment_id, cause, started_at, ended_at, outcome) values (?, ?, 'start', '2026-11-20T08:00:00.000Z', ?, ?)",
      [id, asgOf(desk, id), endedAt, endedAt ? "waited" : null]
    );
  const event = (id: string, chatName: string) =>
    desk.db.run(
      "insert into event (assignment_id, event_id, name, payload, received_at) values (?, 'whatsapp:e1', 'message.received', ?, '2026-11-20T08:30:00.000Z')",
      [
        asgOf(desk, id),
        JSON.stringify({
          at: "2026-11-20T08:30:00.000Z",
          chat: DM,
          chatName,
          id: "whatsapp:e1",
          person: null,
          source: "whatsapp",
        }),
      ]
    );
  const onMatter = register(desk, {
    brief: "Test brief",
    folder,
    runtime: "claude",
  });
  desk.db.run(
    "insert into anchor (assignment_id, step, added_at) values (?, ?, ?)",
    [asgOf(desk, onMatter), "obs_00000000c001", "2026-11-20T08:00:00.000Z"]
  );
  // A matter its agent's anchor finds, and an agent anchored on a step no matter holds.
  const matters = await import("../memory/matters");
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    {
      id: "matter_00000000c001",
      name: "Test matter",
      status: "moving",
      steps: [{ ref: "obs_00000000c001" }],
    },
  ] as never);
  const lost = register(desk, {
    brief: "Test brief",
    folder,
    runtime: "claude",
  });
  desk.db.run(
    "insert into anchor (assignment_id, step, added_at) values (?, ?, ?)",
    [asgOf(desk, lost), "obs_00000000c002", "2026-11-20T08:00:00.000Z"]
  );
  const onProject = register(desk, {
    brief: "Test brief",
    folder,
    runtime: "claude",
  });
  desk.db.run("update agent set project = 'test-shop' where id = ?", [
    onProject,
  ]);
  const running = register(desk, {
    brief: "Test brief",
    folder,
    runtime: "claude",
  });
  const stopped = register(desk, {
    brief: "Test brief",
    folder,
    runtime: "claude",
  });
  desk.db.run("update agent set status = 'stopped' where id = ?", [stopped]);
  const ended = register(desk, {
    brief: "Test brief",
    folder,
    runtime: "claude",
  });
  // Ended a day ago by the clock, so the test never ages out of the read's window.
  const endedAt = new Date(clock().getTime() - DAY).toISOString();
  desk.db.run("update agent set status = 'ended', ended_at = ? where id = ?", [
    endedAt,
    ended,
  ]);

  const chatWait = [filter({ chat: DM })];
  for (const id of [onMatter, lost, onProject, running, stopped]) {
    on(id, chatWait);
  }
  turn(onMatter, "2026-11-20T08:10:00.000Z");
  turn(onProject, "2026-11-20T08:20:00.000Z");
  turn(running, null);
  // Only the matter's agent has heard from that chat: another's name for it is not shown to this one.
  event(onMatter, "Test Ben");
  const deadline = new Date(clock().getTime() + 2 * DAY).toISOString();
  const card = await requestDecision("planner", {
    agent: onMatter,
    context: "A made-up reason to ask.",
    deadline,
    onSilence: null,
    options: [
      { id: "yes", label: "Send it" },
      { id: "no", label: "Not now" },
    ],
    question: "Send Ben the quote?",
    title: "The quote",
  });

  const read = await readRegisteredAgents();
  const by = (id: string) => read.agents.find((a) => a.id === id);
  expect(by(onMatter)?.statusSince).toBe("2026-11-20T08:10:00.000Z");
  expect(by(onMatter)?.wakesOn).toEqual([
    {
      calls: true,
      chat: { app: "whatsapp", group: false, name: "Test Ben" },
      kind: "message",
    },
    {
      card: "Send Ben the quote?",
      check: card.id,
      deadline,
      kind: "answer",
    },
    { kind: "wide_net" },
  ]);
  // A project's agent has no wide net, and no name for a chat only another agent heard from.
  expect(by(onProject)?.wakesOn).toEqual([
    {
      calls: true,
      chat: { app: null, group: null, name: null },
      kind: "message",
    },
  ]);
  // Its anchor finds no matter: nothing listens near it.
  expect(by(lost)?.wakesOn.map((l) => l.kind)).toEqual(["message"]);
  expect(by(running)).toMatchObject({
    status: "running",
    statusSince: "2026-11-20T08:00:00.000Z",
    wakesOn: [],
  });
  expect(by(stopped)).toMatchObject({ statusSince: null, wakesOn: [] });
  expect(by(ended)).toMatchObject({
    statusSince: endedAt,
    wakesOn: [],
  });
  // What an agent has asked, filters and the chats it has heard from stay inside: they are not on the wire.
  expect(by(onMatter)).not.toHaveProperty("filters");
  expect(by(onMatter)).not.toHaveProperty("chatsSeen");

  // The matter's read carries the same lines, without what they are made of.
  const [onIt] = readAgentsOnSteps(["obs_00000000c001"], await readPeople());
  expect(onIt?.wakesOn).toEqual(by(onMatter)?.wakesOn ?? []);
  expect(onIt).not.toHaveProperty("filters");
  expect(onIt).not.toHaveProperty("chatsSeen");
  // A filter's raw chat id never reaches the connector's wait.
  expect(JSON.stringify([by(onMatter), onIt])).not.toContain(DM);

  // The status snapshot's rows never look at the chats an agent heard from; the wake reads do, in its newest 200 events.
  const t = clock().getTime();
  expect(
    agentsNow(desk.db, t).find((a) => a.id === onMatter)?.chatsSeen
  ).toEqual({});
  expect(
    agentsNow(desk.db, t, true).find((a) => a.id === onMatter)?.chatsSeen
  ).toEqual({ [DM]: { name: "Test Ben", source: "whatsapp" } });
  for (let i = 0; i < 200; i += 1) {
    desk.db.run(
      "insert into event (assignment_id, event_id, name, payload, received_at) values (?, ?, 'message.received', '{\"chat\":\"other\"}', '2026-11-20T09:00:00.000Z')",
      [asgOf(desk, onMatter), `whatsapp:o${i}`]
    );
  }
  expect(
    agentsNow(desk.db, t, true).find((a) => a.id === onMatter)?.chatsSeen
  ).toEqual({});
  book.mockRestore();
});
