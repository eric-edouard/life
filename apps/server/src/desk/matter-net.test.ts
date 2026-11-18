import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, MIN } from "../core/clock";
import type { Embedder } from "../core/embedder";
import { queuedEvents } from "../host/desk-read";
import type { Messaging } from "../host/events";
import type { SourceEvent } from "../records/source";
import type { Unit } from "../records/unit";
import { register } from "./agent-actions";
import { pollMessages, pollRecordings } from "./desk-clock";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

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
  told: [],
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

async function mocked() {
  const matters = await import("../memory/matters");
  const who = await import("../memory/who");
  spies.push(
    spyOn(matters, "readMatterBook").mockResolvedValue([matter] as never),
    spyOn(who, "readPeople").mockResolvedValue({
      // One voice was folded into Ana since it was heard.
      refOf: (s: string) =>
        s === "person:ana-voice"
          ? "person:ana"
          : s.startsWith("person:")
            ? s
            : null,
      resolve: (s: string) => (s === "Test Ana" ? "person:ana" : null),
      truth: { people: [] },
    } as never)
  );
}

test("a matter's agent is woken by its people's messages and by messages close to it in meaning, nothing else; its wait's own match is not doubled", async () => {
  await mocked();
  const { agent, desk, write } = setup();
  // Its own wait also wants Ana's chat: her message is queued once, as the wait's.
  desk.db.run("update agent set wait_events = ? where id = ?", [
    JSON.stringify([{ chat: "Test Ana", from_me: false }]),
    agent,
  ]);
  await pollMessages(desk); // the cursor starts now
  const fromAna = write("Test Ana", "ok");
  const close = write("Test Shop", "The beads are ready for pickup on Friday");
  write("Test Bob", "Dinner tonight? The plumber came by");
  write("Test Bob", "bead");
  await pollMessages(desk);
  const events = queuedEvents(desk.db, agent);
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

test("with no embedder, people still wake it", async () => {
  await mocked();
  const { agent, desk, write } = setup(null);
  await pollMessages(desk);
  const fromAna = write("Test Ana", "ok");
  write("Test Shop", "The beads are ready for pickup on Friday");
  await pollMessages(desk);
  expect(queuedEvents(desk.db, agent).map((e) => e.event_id)).toEqual([
    fromAna,
  ]);
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
  await pollRecordings(desk);
  expect(queuedEvents(desk.db, agent)).toEqual([]);
  held = unit(at(10));
  said = [
    ...said,
    line(
      at(10),
      "I still have to get the pickup day for the beads from the shop"
    ),
  ];
  await pollRecordings(desk);
  // Only the new line was compared, in one part.
  expect(calls.at(-1)).toEqual([
    "I still have to get the pickup day for the beads from the shop",
  ]);
  const [event] = queuedEvents(desk.db, agent);
  expect(event?.event_id).toBe(`unit_00000000e001@${at(10)}`);
  expect(JSON.parse(event?.payload ?? "")).toMatchObject({
    id: held.id,
    source: "lifelog",
    why: "meaning",
  });
  // Read up to its end: nothing new, nothing compared.
  const n = calls.length;
  await pollRecordings(desk);
  expect(calls.length).toBe(n);
  // His words read wrong (lifelog down): read again on the next poll, and Ana's voice, folded into her since, wakes it.
  held = unit(at(12));
  said = [...said, line(at(12), "the beads, the pickup", "person:ana-voice")];
  spoken.mockRejectedValueOnce(new Error("down"));
  await pollRecordings(desk);
  expect(queuedEvents(desk.db, agent)).toHaveLength(1);
  await pollRecordings(desk);
  expect(queuedEvents(desk.db, agent).at(-1)).toMatchObject({
    event_id: `unit_00000000e001@${at(12)}`,
  });
  expect(
    JSON.parse(queuedEvents(desk.db, agent).at(-1)?.payload ?? "")
  ).toMatchObject({ why: "person" });
});
