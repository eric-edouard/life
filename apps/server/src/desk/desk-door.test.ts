import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, HOUR, iso } from "../core/clock";
import { currentAssignmentOf } from "../host/desk-read";
import { decisionsNow } from "../memory/decisions";
import { AgentWait } from "../records/registered-agent";
import { readPacket, register } from "./agent-actions";
import { doorFetch, doorOf } from "./desk-door";
import { type Desk, openDesk } from "./desk-store";
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

const ask = (question: string) => ({
  deadline: ahead(DAY),
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  question,
  title: "a test",
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
  await call(id, doorOf(id).key, "request_decision", ask("Test: plan?"));
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
  const first = await call(id, key, "request_decision", ask("Test: bake?"));
  const dec = JSON.parse(first.text ?? "{}").id as string;
  const asked = decisionsNow().find((d) => d.id === dec);
  expect(asked).toMatchObject({
    agent: id,
    asker: "desk",
    links: [`fake://${id}`],
  });
  const second = await call(id, key, "request_decision", ask("Test: again?"));
  expect(second.result?.isError).toBe(true);
  const stolen = await call(other, doorOf(other).key, "request_decision", {
    why: "not mine",
    withdraw: dec,
  });
  expect(stolen.text).toContain("is not a card of this turn's assignment");
  await call(id, key, "request_decision", { why: "done", withdraw: dec });
  expect(decisionsNow().find((d) => d.id === dec)?.state).toBe("withdrawn");
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
  const withdrawn = await call(id, key, "request_decision", ask("Test: plan?"));
  await call(id, key, "request_decision", {
    why: "Test: rethought",
    withdraw: JSON.parse(withdrawn.text ?? "{}").id,
  });
  expect((await call(id, key, "set_wait", wait)).text).toContain(
    "ask your plan first"
  );
  await call(id, key, "request_decision", ask("Test: go with the plan?"));
  expect((await call(id, key, "set_wait", wait)).result?.isError).toBe(false);
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
  await call(id, key, "request_decision", ask("Test: send this?"));
  expect((await call(id, key, "set_wait", wait)).result?.isError).toBe(false);
});

test("an agent that finished may read its packet, nothing else", async () => {
  const id = agent();
  const { key } = doorOf(id);
  await call(id, key, "request_decision", ask("Test: plan?"));
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
    expect(text).toContain("act only after his Go");
    expect(text).toContain("name the matter before you act");
    expect(text).toContain("never with a Monitor");
    expect(text).toContain("`github` is a wait channel");
    expect(text).toContain("he is here, so answer and ask him in the chat");
    expect(text).toContain("never a question left in the chat");
  }
});
