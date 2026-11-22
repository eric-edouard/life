import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, HOUR, iso } from "../core/clock";
import { DESK_AGENT } from "../core/names";
import { ask as recordAsk } from "../host/asks";
import { currentAssignmentOf } from "../host/desk-read";
import { ASK_SPOKEN } from "../host/events";
import { isHisWordsPlanOf } from "../host/inbox";
import { decisionsNow } from "../memory/decisions";
import { AgentWait } from "../records/registered-agent";
import { readPacket, register } from "./agent-actions";
import { doorFetch } from "./desk-door";
import { type Desk, openDesk } from "./desk-store";
import { doorOf } from "./door-keys";
import { firstTurnOf } from "./first-turns";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { on } from "./test-desk";

// The door: an agent is known by its key alone; its tools reach the desk's actions. Made-up agents and briefs.

const dir = mkdtempSync(join(tmpdir(), "life-door-"));
const desk: Desk = {
  db: openDesk(join(dir, "desk.sqlite")),
  runtimes: { fake: fakeRuntime().runtime },
};
const fetchDoor = doorFetch(desk);
const ahead = (ms: number) => iso(clock().getTime() + ms);

/** A made-up agent in a desk turn on its one assignment: the door's tools act on that turn's. */
const agent = (brief = "Test brief: a made-up bakery's order") => {
  const id = register(desk, { brief, folder: dir, runtime: "fake" });
  desk.db.run("update agent set link = ? where id = ?", [`fake://${id}`, id]);
  turnOn(id, on(desk, id).id);
  return id;
};
let spokenCount = 0;
/** His spoken ask of the desk, recorded: its id. */
const spokenAsk = () => {
  spokenCount += 1;
  return recordAsk(
    {
      at: clock().toISOString(),
      quote: "hey Life, order the test cake",
      ref: `door-job:${spokenCount}@x`,
    },
    { agent: DESK_AGENT, confidence: "high", conversation: "c1", turns: [0] },
    "watch",
    "heard its wake"
  ).id;
};
const turnOn = (id: string, assignment: string) =>
  desk.db.run(
    "insert into turn (agent_id, assignment_id, cause, started_at) values (?, ?, 'first turn', ?)",
    [id, assignment, clock().toISOString()]
  );

async function call(id: string, key: string, name: string, args: object) {
  const res = await fetchDoor(
    new Request(`http://127.0.0.1/mcp/${id}`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      method: "POST",
    })
  );
  const body = await res.text();
  const data = body.split("\n").find((l) => l.startsWith("data:"));
  const result = res.ok
    ? (JSON.parse(data ? data.slice(5) : body).result as {
        content: { text: string }[];
        isError: boolean;
      })
    : null;
  return { result, status: res.status, text: result?.content[0]?.text };
}

/** A card asked as an agent asks it: its preview first, then the same card with the preview's digest. */
async function askCard(id: string, key: string, card: object) {
  const preview = await call(id, key, "request_decision", card);
  const { previewed } = JSON.parse(preview.text ?? "{}");
  return call(id, key, "request_decision", { ...card, previewed });
}

const ask = (question: string) => ({
  context: "A made-up reason to ask.",
  deadline: ahead(DAY),
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  question,
  title: "a test",
});

/** An assignment's plan card: its steps, and the two options a plan card has. */
const planAsk = (question: string) => ({
  ...ask(question),
  options: [
    { id: "start", label: "Start the plan" },
    { id: "decline", label: "Not this plan" },
  ],
  plan: [{ by: "agent", text: "Do the one step" }],
});

test("the door refuses a wrong key, another agent's key and an unknown agent alike", async () => {
  const id = agent();
  const other = agent();
  const wait = {
    events: [{ text_matches: "blue envelope" }],
    reason: "A delivery update",
    until: ahead(HOUR),
  };
  expect((await call(id, "0".repeat(64), "set_wait", wait)).status).toBe(401);
  expect((await call(id, doorOf(other).key, "set_wait", wait)).status).toBe(
    401
  );
  expect(
    (await call("agt_000000000000", doorOf(id).key, "set_wait", wait)).status
  ).toBe(401);
  await askCard(id, doorOf(id).key, planAsk("Test: plan?"));
  const ok = await call(id, doorOf(id).key, "set_wait", wait);
  expect(ok.result?.isError).toBe(false);
  expect(currentAssignmentOf(desk.db, id)?.wait_reason).toBe(wait.reason);
  const packet = await call(id, doorOf(id).key, "read_packet", {});
  const shown = packet.text?.split("Your wait: ")[1]?.split("\n")[0];
  const copy = JSON.parse(shown ?? "null");
  expect(copy).toEqual({
    ...wait,
    events: [{ from_me: false, text_matches: "blue envelope" }],
  });
  expect(AgentWait.safeParse(copy).success).toBe(true);
});

test("request_decision asks as the desk, stamped with the agent and its link; one open at a time; only its own withdrawn", async () => {
  const id = agent();
  const other = agent();
  const { key } = doorOf(id);
  const first = await askCard(id, key, planAsk("Test: bake?"));
  const dec = JSON.parse(first.text ?? "{}").id as string;
  const asked = decisionsNow().find((d) => d.id === dec);
  expect(asked).toMatchObject({
    agent: id,
    asker: "desk",
    links: [`fake://${id}`],
  });
  const second = await askCard(id, key, planAsk("Test: again?"));
  expect(second.result?.isError).toBe(true);
  const stolen = await call(other, doorOf(other).key, "request_decision", {
    why: "not mine",
    withdraw: dec,
  });
  expect(stolen.text).toContain("is not a card of this turn's assignment");
  await call(id, key, "request_decision", { why: "done", withdraw: dec });
  expect(decisionsNow().find((d) => d.id === dec)?.state).toBe("withdrawn");
});

// Cards that added to his load (22 Nov 2026): an agent reads each card as his phone shows it before it is asked.
test("an agent's card comes back as its preview, asked only when repeated unchanged with its digest", async () => {
  const id = agent();
  const { key } = doorOf(id);
  const card = planAsk("Test: bake the cake?");
  const before = decisionsNow().length;
  const first = await call(id, key, "request_decision", card);
  const shown = JSON.parse(first.text ?? "{}");
  expect(shown.asked).toBe(false);
  expect(shown.previewed).toMatch(/^[0-9a-f]{12}$/);
  expect(shown.preview).toContain("Card: Test: bake the cake?");
  expect(shown.preview).toContain("[Tell the agent…]");
  expect(shown.preview).toContain("Before any card, read it as he will");
  expect(decisionsNow()).toHaveLength(before);
  const changed = await call(id, key, "request_decision", {
    ...planAsk("Test: bake the pie?"),
    previewed: shown.previewed,
  });
  expect(JSON.parse(changed.text ?? "{}").asked).toBe(false);
  expect(decisionsNow()).toHaveLength(before);
  const done = await call(id, key, "request_decision", {
    ...card,
    previewed: shown.previewed,
  });
  expect(JSON.parse(done.text ?? "{}").id).toMatch(/^dec_/);
});

test("a new agent waits or finishes only once it asked its plan", async () => {
  const id = agent();
  const { key } = doorOf(id);
  const wait = { events: [], reason: "r", until: ahead(HOUR) };
  expect((await call(id, key, "set_wait", wait)).text).toContain(
    "ask your plan first"
  );
  expect(
    (await call(id, key, "finish", { outcome: "Test: done" })).text
  ).toContain("ask your plan first");
  const withdrawn = await askCard(id, key, planAsk("Test: plan?"));
  await call(id, key, "request_decision", {
    why: "Test: rethought",
    withdraw: JSON.parse(withdrawn.text ?? "{}").id,
  });
  expect((await call(id, key, "set_wait", wait)).text).toContain(
    "ask your plan first"
  );
  await askCard(id, key, planAsk("Test: go with the plan?"));
  expect((await call(id, key, "set_wait", wait)).result?.isError).toBe(false);
});

test("the Personal agent holding his spoken ask may wait without a plan card: his words are its plan", async () => {
  const id = agent();
  const s = on(desk, id);
  const wait = { events: [], reason: "r", until: ahead(HOUR) };
  desk.db.run("update agent set role = 'personal' where id = ?", [id]);
  // Personal with no spoken ask yet: a plan card first.
  expect(firstTurnOf(desk.db, { role: "personal" }, s)).toContain("plan card");
  expect((await call(id, doorOf(id).key, "set_wait", wait)).text).toContain(
    "ask your plan first"
  );
  desk.db.run(
    "insert into event (assignment_id, event_id, name, payload, received_at) values (?, 'entry_00000000000a', ?, '{}', ?)",
    [s.id, ASK_SPOKEN, clock().toISOString()]
  );
  expect(firstTurnOf(desk.db, { role: "personal" }, s)).toContain(
    "his words are your plan"
  );
  expect(
    (await call(id, doorOf(id).key, "set_wait", wait)).result?.isError
  ).toBe(false);
});

test("a spoken ask is read at the door only by the assignment it was routed to; a matter's assignment keeps its card", async () => {
  const id = agent();
  const other = agent();
  const spoken = spokenAsk();
  desk.db.run(
    "insert into event (assignment_id, event_id, name, payload, received_at) values (?, ?, ?, '{}', ?)",
    [on(desk, id).id, spoken, ASK_SPOKEN, clock().toISOString()]
  );
  const read = (who: string) =>
    call(who, doorOf(who).key, "read_spoken_ask", { ask: spoken });
  expect(JSON.parse((await read(id)).text ?? "{}")).toMatchObject({
    words: "hey Life, order the test cake",
  });
  expect((await read(other)).text).toContain("was received here");
  // On a matter (anchored), the Personal agent's assignment keeps its card even with a spoken ask.
  expect(isHisWordsPlanOf(desk.db, { role: "personal" }, on(desk, id))).toBe(
    true
  );
  desk.db.run(
    "insert into anchor (assignment_id, step, added_at) values (?, 'obs_00000000000a', ?)",
    [on(desk, id).id, clock().toISOString()]
  );
  expect(isHisWordsPlanOf(desk.db, { role: "personal" }, on(desk, id))).toBe(
    false
  );
});

test("a handed-out agent is told to ask its card, not its plan", async () => {
  const id = agent();
  desk.db.run("update assignment set opened_by = 'desk' where agent_id = ?", [
    id,
  ]);
  const { key } = doorOf(id);
  const wait = { events: [], reason: "r", until: ahead(HOUR) };
  const refused = (await call(id, key, "set_wait", wait)).text;
  expect(refused).toContain("ask your card first");
  expect(refused).not.toContain("plan");
  await askCard(id, key, ask("Test: send this?"));
  expect((await call(id, key, "set_wait", wait)).result?.isError).toBe(false);
});

test("an agent that finished may read its packet, nothing else", async () => {
  const id = agent();
  const { key } = doorOf(id);
  await askCard(id, key, planAsk("Test: plan?"));
  await call(id, key, "finish", { outcome: "Test: done" });
  const notes = await call(id, key, "write_notes", { text: "late" });
  expect(notes.text).toContain("not active");
  const packet = await call(id, key, "read_packet", {});
  expect(packet.text).not.toContain("Your wait");
  expect(packet.text).toContain("a made-up bakery");
  expect(packet.text).toContain("set_wait");
  expect(packet.text).toContain("The one gate");
});

test("a stopped agent's open assignment has no current wait", async () => {
  const id = agent();
  const assignment = on(desk, id);
  expect(await readPacket(desk, assignment, true)).toContain("Your wait");
  desk.db.run("update agent set status = 'stopped' where id = ?", [id]);
  expect(await readPacket(desk, assignment, true)).not.toContain("Your wait");
});

test("the contract: his own Life's agent is told the Mac is its own; a second Life's has its door's tools only; both keep the gate and the first-turn rule", async () => {
  const id = agent();
  const own = await readPacket(desk, on(desk, id), true);
  const second = await readPacket(desk, on(desk, id), false);
  expect(own).toContain("this Mac is yours");
  expect(own).toContain("1Password");
  expect(own).toContain("Reaching him");
  for (const text of [second]) {
    expect(text).toContain("You have your door's tools only.");
    expect(text).not.toContain("this Mac is yours");
    expect(text).not.toContain("1Password");
    expect(text).not.toContain("Reaching him");
  }
  for (const text of [own, second]) {
    expect(text).toContain("The one gate");
    expect(text).toContain(
      "Act only after his `start`; on his `decline`, `finish`"
    );
    // The plan card's rules are in the brief: an agent with its door alone has no `fetch`.
    expect(text).toContain('{"id":"start","label":"Start the plan"}');
    // His words of 21 and 22 Nov 2026: a plan reads as steps his app draws, never a wall of text in `context`.
    expect(text).toContain(
      "Any plan on any card goes in `plan`, its steps, never as a numbered list in `context`."
    );
    expect(text).toContain("name the matter before you act");
    expect(text).toContain("never with a Monitor");
    expect(text).toContain("`github` is a wait channel");
    expect(text).toContain("he is here, so answer and ask him in the chat");
    expect(text).toContain("never by his yes in the chat");
    expect(text).toContain(
      "every question or decision that needs his answer goes as a card"
    );
    expect(text).toContain("never a question left in the chat");
    expect(text).toContain("An `arrival.confirmed` event");
    expect(text).toContain("his own commitment");
    expect(text).toContain(
      "Write a card's `context` in Markdown: why you ask, why this draft, what you tried"
    );
    expect(text).toContain("a dead link refuses the card");
    expect(text).toContain(
      'A wait can watch GitHub: `channels: ["github_activity"]` with `repo: "owner/name"`'
    );
  }
});
