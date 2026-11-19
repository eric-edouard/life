import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, HOUR, iso } from "../core/clock";
import { agentOf } from "../host/desk-read";
import { decisionsNow } from "../memory/decisions";
import { readPacket, register } from "./agent-actions";
import { doorFetch, doorOf } from "./desk-door";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// The door: an agent is known by its key alone; its tools reach the desk's actions. Made-up agents and briefs.

const dir = mkdtempSync(join(tmpdir(), "life-door-"));
const desk: Desk = {
  db: openDesk(join(dir, "desk.sqlite")),
  runtimes: { fake: fakeRuntime().runtime },
};
const fetchDoor = doorFetch(desk);
const ahead = (ms: number) => iso(clock().getTime() + ms);

const agent = (brief = "Test brief: a made-up bakery's order") => {
  const id = register(desk, { brief, folder: dir, runtime: "fake" });
  desk.db.run("update agent set link = ? where id = ?", [`fake://${id}`, id]);
  return id;
};

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
  const wait = { events: [], reason: "r", until: ahead(HOUR) };
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
  expect(agentOf(desk.db, id)?.wait_reason).toBe("r");
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
  expect(stolen.text).toContain("another agent");
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

test("an agent that finished may read its packet, nothing else", async () => {
  const id = agent();
  const { key } = doorOf(id);
  await call(id, key, "request_decision", ask("Test: plan?"));
  await call(id, key, "finish", { outcome: "Test: done" });
  const notes = await call(id, key, "write_notes", { text: "late" });
  expect(notes.text).toContain("not active");
  const packet = await call(id, key, "read_packet", {});
  expect(packet.text).toContain("a made-up bakery");
  expect(packet.text).toContain("set_wait");
  expect(packet.text).toContain("The one gate");
});

test("the contract: his own Life's agent is told the Mac is its own; a second Life's has its door's tools only; both keep the gate and the first-turn rule", async () => {
  const id = agent();
  const own = await readPacket(desk, id, true);
  const second = await readPacket(desk, id, false);
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
  }
});
