import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, iso, MIN } from "../core/clock";
import type { Embedder } from "../core/embedder";
import { writeWhole } from "../core/files";
import { DESK_AGENT } from "../core/names";
import { asksFor } from "../host/asks";
import { agentOf, currentAssignmentOf, queuedEvents } from "../host/desk-read";
import type { Messaging } from "../host/events";
import { MATTER_OVER_OUTCOME } from "../memory/held-matters";
import { CORRECTIONS, recordCorrection } from "../memory/memory-files";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import { openAssignment, register } from "./agent-actions";
import { pollMessages, readPeopleOnce, tick } from "./desk-clock";
import {
  closeAssignmentRow,
  type Desk,
  openDesk,
  saveCursor,
  writeWait,
} from "./desk-store";
import {
  endOutcomeOf,
  MATTER_DONE_OUTCOME,
  pollRecordings,
} from "./matter-net";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { asgOf } from "./test-desk";

// The wide net: an agent on a matter is woken by its people's messages and by messages and recordings close to it in
// meaning. A made-up matter, chat and recording; a fake embedder whose vectors count a few words.

const T0 = Date.UTC(2026, 10, 18, 9, 0);
const STEP = "obs_00000000e001";
const WORDS = ["bead", "pickup", "dinner", "plumber"];

/** A vector per text: how often each of `WORDS` is in it, so texts on the same thing are close. */
const fakeEmbedder = (calls: string[][]): Embedder => ({
  embed: (texts) => {
    calls.push(texts);
    return Promise.resolve(
      texts.map((t) => [
        ...WORDS.map((w) => t.toLowerCase().split(w).length - 1),
        0.01,
      ])
    );
  },
  model: "fake",
});

const matter = {
  areas: [],
  goal: {
    at: "2026-11-17T02:00:00.000Z",
    by: "life",
    text: "Ana has her beads",
  },
  id: "matter_00000000e001",
  name: "Bead order",
  nextStep: {
    at: "2026-11-17T02:00:00.000Z",
    by: "life",
    kind: "do",
    text: "Ask the shop for the pickup day of the beads",
  },
  owedTo: ["person:ana"],
  steps: [
    {
      day: "2026-11-16",
      kind: "to_do",
      quote: "",
      ref: STEP,
      text: "Order the beads",
    },
  ],
  waitingOn: ["person:shop"],
  with: [],
};

function setup(embedder: Embedder | null = fakeEmbedder([])) {
  setSystemTime(new Date(T0));
  const messages: SourceEvent[] = [];
  const desk: Desk = {
    db: openDesk(join(mkdtempSync(join(tmpdir(), "life-net-")), "desk.sqlite")),
    embedder,
    runtimes: { fake: fakeRuntime().runtime },
    sources: [
      {
        incoming: (from: number) => ({
          end: messages.length + 1,
          rows: messages
            .map((e, i) => ({ at: e.at, id: e.id, row: i + 1 }))
            .filter((r) => r.row >= from),
        }),
        kind: "chat",
        label: "WhatsApp",
        name: "whatsapp",
        read: () => messages,
        silentAfter: 0,
      } as Messaging,
    ],
  };
  // The ledger is every test file's: this desk applies none of the asks made before it.
  let page = asksFor(DESK_AGENT);
  while (page.asks.length > 0) {
    page = asksFor(DESK_AGENT, page.cursor);
  }
  saveCursor(desk.db, "asks", page.cursor);
  const agent = register(desk, {
    brief: "b",
    folder: "/",
    runtime: "fake",
    steps: [STEP],
  });
  const write = (chat: string, text: string, fromMe = false) => {
    const id = `whatsapp:m${messages.length + 1}`;
    messages.push({
      at: clock().toISOString(),
      chat,
      fromMe,
      id,
      sender: chat,
      source: "whatsapp",
      text,
    });
    return id;
  };
  return { agent, desk, write };
}

const spies: { mockRestore: () => void }[] = [];
afterEach(() => {
  setSystemTime();
  for (const s of spies.splice(0)) {
    s.mockRestore();
  }
});

async function mocked(status = "moving") {
  const matters = await import("../memory/matters");
  const who = await import("../memory/who");
  spies.push(
    spyOn(matters, "readMatterBookAndRecords").mockResolvedValue({
      book: [
        {
          ...matter,
          open: !["done", "probably_done"].includes(status),
          status,
        },
      ],
      records: {},
    } as never),
    spyOn(who, "readPeople").mockResolvedValue({
      // One voice was folded into Ana since it was heard.
      refOf: (s: string) =>
        s.startsWith("person:") ? s.replace("-voice", "") : null,
      resolve: (s: string) => (s === "Test Ana" ? "person:ana" : null),
      truth: { people: [], projects: [] },
    } as never)
  );
}

test("a matter's agent is woken by its people's messages and by messages close to it in meaning, nothing else; its wait's own match is not doubled", async () => {
  await mocked();
  const { agent, desk, write } = setup();
  // Its own wait also wants Ana's chat: her message is queued once, as the wait's.
  desk.db.run("update assignment set wait_events = ? where agent_id = ?", [
    JSON.stringify([{ chat: "Test Ana", from_me: false }]),
    agent,
  ]);
  await pollMessages(desk, readPeopleOnce()); // the cursor starts now
  const fromAna = write("Test Ana", "ok");
  const close = write("Test Shop", "The beads are ready for pickup on Friday");
  write("Test Bob", "Dinner tonight? The plumber came by");
  write("Test Bob", "bead");
  await pollMessages(desk, readPeopleOnce());
  const events = queuedEvents(desk.db, asgOf(desk, agent));
  expect(events.map((e) => [e.name, e.event_id])).toEqual([
    ["message.received", fromAna],
    ["matter.related", close],
  ]);
  expect(JSON.parse(events[0]?.payload ?? "")).toMatchObject({
    person: "person:ana",
  });
  expect(JSON.parse(events[1]?.payload ?? "")).toMatchObject({
    why: "meaning",
  });
  expect(
    JSON.parse(events[1]?.payload ?? "").similarity
  ).toBeGreaterThanOrEqual(0.55);
});

// Regression, 20 Nov 2026 (the debt verdict on PR 1): a message read after the shared cursor but sent before an
// assignment was opened is not new to it, by its wait nor by the wide net.
test("a message from before an assignment was opened wakes it neither by its wait nor by its matter", async () => {
  await mocked();
  const { agent, desk, write } = setup();
  await pollMessages(desk, readPeopleOnce()); // the cursor starts now
  setSystemTime(new Date(T0 + MIN));
  const fromAna = write("Test Ana", "ok");
  setSystemTime(new Date(T0 + 2 * MIN));
  const later = openAssignment(desk, agent, {
    openedBy: "owner",
    steps: [STEP],
  });
  writeWait(
    desk.db,
    later,
    {
      events: [{ chat: "Test Ana", from_me: false }],
      reason: "r",
      until: iso(T0 + DAY),
    },
    false
  );
  await pollMessages(desk, readPeopleOnce());
  expect(
    queuedEvents(desk.db, asgOf(desk, agent)).map((e) => e.event_id)
  ).toEqual([fromAna]);
  expect(queuedEvents(desk.db, later)).toEqual([]);
});

test("with no embedder, people still wake it", async () => {
  await mocked();
  const { agent, desk, write } = setup(null);
  await pollMessages(desk, readPeopleOnce());
  const fromAna = write("Test Ana", "ok");
  write("Test Shop", "The beads are ready for pickup on Friday");
  await pollMessages(desk, readPeopleOnce());
  expect(
    queuedEvents(desk.db, asgOf(desk, agent)).map((e) => e.event_id)
  ).toEqual([fromAna]);
});

test("his pendant's new words close to the matter wake it once, read from where the last poll stopped; a failed read is read again", async () => {
  await mocked();
  const words = await import("../memory/words");
  const memoryFiles = await import("../memory/memory-files");
  const calls: string[][] = [];
  const { agent, desk } = setup(fakeEmbedder(calls));
  const unit = (end: string) =>
    ({
      drop: undefined,
      end,
      hash: end,
      id: "unit_00000000e001",
      source: "lifelog",
    }) as unknown as Unit;
  const line = (when: string, text: string, speaker = "person:me") => ({
    at: when,
    ref: when,
    speaker,
    text,
  });
  const at = (m: number) => new Date(T0 + m * MIN).toISOString();
  let held = unit(at(5));
  let said = [
    line(at(-5), "Before the agent: the beads"),
    line(at(5), "We talked about dinner"),
  ];
  const spoken = spyOn(words, "spokenLines").mockImplementation(() =>
    Promise.resolve(new Map([[held.id, said]]))
  );
  spies.push(
    spyOn(memoryFiles, "readUnitsOf").mockImplementation(() => [held]),
    spoken
  );
  setSystemTime(new Date(T0 + 6 * MIN));
  await pollRecordings(desk, readPeopleOnce());
  expect(queuedEvents(desk.db, asgOf(desk, agent))).toEqual([]);
  held = unit(at(10));
  said = [
    ...said,
    line(
      at(10),
      "I still have to get the pickup day for the beads from the shop"
    ),
  ];
  await pollRecordings(desk, readPeopleOnce());
  // Only the new line was compared, in one part.
  expect(calls.at(-1)).toEqual([
    "I still have to get the pickup day for the beads from the shop",
  ]);
  const [event] = queuedEvents(desk.db, asgOf(desk, agent));
  expect(event?.event_id).toBe(`unit_00000000e001@${at(10)}`);
  expect(JSON.parse(event?.payload ?? "")).toMatchObject({
    id: held.id,
    source: "lifelog",
    why: "meaning",
  });
  // Read up to its end: nothing new, nothing compared.
  const n = calls.length;
  await pollRecordings(desk, readPeopleOnce());
  expect(calls.length).toBe(n);
  // His words read wrong (the voice server down): read again on the next poll, and Ana's voice, folded into her since, wakes it.
  held = unit(at(12));
  said = [...said, line(at(12), "the beads, the pickup", "person:ana-voice")];
  spoken.mockRejectedValueOnce(new Error("down"));
  await pollRecordings(desk, readPeopleOnce());
  expect(queuedEvents(desk.db, asgOf(desk, agent))).toHaveLength(1);
  await pollRecordings(desk, readPeopleOnce());
  expect(queuedEvents(desk.db, asgOf(desk, agent)).at(-1)).toMatchObject({
    event_id: `unit_00000000e001@${at(12)}`,
  });
  expect(
    JSON.parse(queuedEvents(desk.db, asgOf(desk, agent)).at(-1)?.payload ?? "")
  ).toMatchObject({ why: "person" });
});

test("an agent whose matter is done is ended; one only probably done (a link's) keeps going", async () => {
  await mocked("probably_done");
  const { agent, desk } = setup();
  // Its first turn not due yet: this tick only polls.
  desk.db.run("update assignment set wait_until = ? where agent_id = ?", [
    new Date(T0 + DAY).toISOString(),
    agent,
  ]);
  await tick(desk);
  expect(agentOf(desk.db, agent)?.status).toBe("active");
  for (const s of spies.splice(0)) {
    s.mockRestore();
  }
  await mocked("done");
  // His Mark as done records a correction: the next poll sees the change, a minute later, not 10.
  setSystemTime(new Date(T0 + MIN));
  // The corrections are every test's: put back as they were after.
  const before = existsSync(CORRECTIONS) ? readFileSync(CORRECTIONS) : null;
  try {
    await recordCorrection({
      kind: "outdated",
      note: "done",
      observations: [STEP],
    });
    await tick(desk);
  } finally {
    if (before) {
      writeWhole(CORRECTIONS, before);
    } else {
      rmSync(CORRECTIONS, { force: true });
    }
  }
  expect(agentOf(desk.db, agent)?.status).toBe("ended");
  expect(currentAssignmentOf(desk.db, agent)?.outcome).toBe(
    "its matter is done"
  );
});

// Findings 1 and 5 of the action pipeline review (20 Nov 2026): an agent stayed on a matter that was no longer running,
// its hidden card blocking the hand-out. A handed-out one is ended; one he started himself only on done or his stop.
test("a handed-out agent whose matter is no longer running is ended as over; his own keeps going", async () => {
  await mocked("probably_done");
  const { agent, desk } = setup();
  const handed = register(desk, {
    brief: "b",
    folder: "/",
    runtime: "fake",
    steps: [STEP],
  });
  desk.db.run("update assignment set opened_by = 'desk' where agent_id = ?", [
    handed,
  ]);
  for (const id of [agent, handed]) {
    desk.db.run("update assignment set wait_until = ? where agent_id = ?", [
      new Date(T0 + DAY).toISOString(),
      id,
    ]);
  }
  await tick(desk);
  expect(agentOf(desk.db, agent)?.status).toBe("active");
  expect(agentOf(desk.db, handed)?.status).toBe("ended");
  expect(currentAssignmentOf(desk.db, handed)?.outcome).toBe(
    MATTER_OVER_OUTCOME
  );
});

test("which matters end which agents: done ends any; not running (probably done, dormant, closed) only a handed-out one", () => {
  const of = (status: string, open: boolean) =>
    (["owner", "desk"] as const).map((openedBy) =>
      endOutcomeOf(openedBy, { open, status } as never)
    );
  expect(of("done", false)).toEqual([MATTER_DONE_OUTCOME, MATTER_DONE_OUTCOME]);
  expect(of("probably_done", false)).toEqual([null, MATTER_OVER_OUTCOME]);
  expect(of("dormant", true)).toEqual([null, MATTER_OVER_OUTCOME]);
  expect(of("moving", true)).toEqual([null, null]);
  expect(of("stuck", true)).toEqual([null, null]);
});

test("a poll with nothing changed does not read the matter book again", async () => {
  await mocked();
  const { agent, desk } = setup();
  desk.db.run("update assignment set wait_until = ? where agent_id = ?", [
    new Date(T0 + DAY).toISOString(),
    agent,
  ]);
  const [book] = spies;
  // Two polls a minute apart, every reader of the nets included (messages, recordings, done matters): one read.
  await tick(desk);
  setSystemTime(new Date(T0 + MIN));
  await tick(desk);
  expect(book).toHaveBeenCalledTimes(1);
});

test("one agent's two assignments on the matter a message relates to: one wake, for the first opened", async () => {
  await mocked();
  const { agent, desk, write } = setup();
  const second = openAssignment(desk, agent, {
    openedBy: "owner",
    steps: [STEP],
  });
  await pollMessages(desk, readPeopleOnce());
  const fromAna = write("Test Ana", "ok");
  await pollMessages(desk, readPeopleOnce());
  expect(
    queuedEvents(desk.db, asgOf(desk, agent)).map((e) => e.event_id)
  ).toEqual([fromAna]);
  expect(queuedEvents(desk.db, second)).toEqual([]);
});

// Regression: the recordings' read mark lives in the process; read again after a restart, a recording whose first
// assignment had closed went to the agent's other assignment on the matter.
test("a recording read again after a restart, the assignment it woke closed, wakes no other assignment of its agent", async () => {
  await mocked();
  const words = await import("../memory/words");
  const memoryFiles = await import("../memory/memory-files");
  const { agent, desk } = setup(fakeEmbedder([]));
  openAssignment(desk, agent, { openedBy: "owner", steps: [STEP] });
  const at = new Date(T0 + 10 * MIN).toISOString();
  const said = "I still have to get the pickup day for the beads from the shop";
  spies.push(
    spyOn(memoryFiles, "readUnitsOf").mockImplementation(() => [
      {
        end: at,
        hash: at,
        id: "unit_00000000e002",
        source: "lifelog",
      } as unknown as Unit,
    ]),
    spyOn(words, "spokenLines").mockImplementation(() =>
      Promise.resolve(
        new Map([
          [
            "unit_00000000e002",
            [{ at, ref: at, speaker: "person:me", text: said }],
          ],
        ])
      )
    )
  );
  setSystemTime(new Date(T0 + 11 * MIN));
  await pollRecordings(desk, readPeopleOnce());
  const queued = desk.db
    .query<{ assignment_id: string }, []>("select assignment_id from event")
    .all();
  expect(queued).toHaveLength(1);
  closeAssignmentRow(desk.db, queued[0]?.assignment_id ?? "", {
    outcome: "test",
  });
  desk.db = openDesk(desk.db.filename);
  await pollRecordings(desk, readPeopleOnce());
  expect(desk.db.query("select assignment_id from event").all()).toEqual(
    queued
  );
});
