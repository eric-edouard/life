import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN } from "../../core/clock";
import { register } from "../agent-actions";
import { BEGIN_WITHIN_MS } from "../agent-wait";
import { tick, wakeDue } from "../desk-clock";
import { doorOf } from "../desk-door";
import { advance, setup } from "../test-desk";
import { acpRuntime } from "./acp-runtime";
import type { Agent } from "./contract";
import type { Row } from "./runtime-rows";

// The ACP runtime against a made-up ACP agent (`fake-acp-agent.ts`), one case per rule the wait contract leans on.
// Nothing runs a real adapter.

// Each case starts a process: a loaded Mac needs more than the default 5 s.
setDefaultTimeout(30_000);

const FAKE = join(import.meta.dir, "fake-acp-agent.ts");

/** A row for the fake agent; its log is read by `logOf`. */
const rowFor = (
  dir: string,
  state: Row["readSessionState"] = () => Promise.resolve("idle")
): Row => ({
  block: () => Promise.resolve(undefined),
  config: { effort: "effort", model: "model" },
  doorPrefix: "mcp__desk__",
  header: (key) => `Bearer ${key}`,
  link: (ref) => `fake://${ref}`,
  readSessionState: state,
  spawn: (a) => ({
    command: [process.execPath, FAKE],
    env: {
      FAKE_ACP_LOG: join(dir, "log.jsonl"),
      ...(a.title === "stall" ? { FAKE_ACP_STALL: "1" } : {}),
    },
  }),
});

const agentIn = (title = "Test"): Agent => ({
  door: {
    key: "k-0123456789abcdef",
    url: "http://127.0.0.1:1/mcp/agt_0123456789ab",
  },
  effort: "low",
  folder: tmpdir(),
  id: "agt_0123456789ab",
  model: "haiku",
  title,
});

const made = () => mkdtempSync(join(tmpdir(), "life-acp-"));
type Line = Record<string, unknown> & { pid: number };
const logOf = (dir: string) =>
  readFileSync(join(dir, "log.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Line);
/** The kinds of line the fake agent logged, in order. */
const kindsOf = (dir: string) =>
  logOf(dir).map((l) => Object.keys(l).find((k) => k !== "pid"));
const isGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("start: the door goes in as an HTTP MCP server with its header, the model and effort are set before the prompt, the run begins after it, usage is mapped", async () => {
  const dir = made();
  const run = await acpRuntime(rowFor(dir)).start(agentIn(), "[answer]");
  expect(run.link).toBe(`fake://${run.ref}`);
  await run.begun;
  expect(await run.ended).toEqual({
    ok: true,
    usage: {
      contextFirst: 1000,
      contextLast: 1500,
      tokensCached: 100,
      tokensIn: 30,
      tokensOut: 5,
    },
  });
  expect(kindsOf(dir)).toEqual([
    "initialize",
    "made",
    "config",
    "config",
    "prompt",
  ]);
  const lines = logOf(dir);
  expect(lines[1]?.new).toMatchObject({
    mcpServers: [
      {
        headers: [
          { name: "Authorization", value: "Bearer k-0123456789abcdef" },
        ],
        name: "desk",
        type: "http",
      },
    ],
  });
  expect(lines.filter((l) => l.config).map((l) => l.config)).toMatchObject([
    { configId: "model", value: "haiku" },
    { configId: "effort", value: "low" },
  ]);
});

test("send: resume, then model and effort again, then the prompt", async () => {
  const dir = made();
  const rt = acpRuntime(rowFor(dir));
  const first = await rt.start(agentIn(), "[answer]");
  await first.ended;
  const run = await rt.send(agentIn(), first.ref, "[answer]");
  await run.begun;
  expect((await run.ended).ok).toBe(true);
  expect(kindsOf(dir).slice(5)).toEqual([
    "initialize",
    "resume",
    "config",
    "config",
    "prompt",
  ]);
});

test("a rejected prompt ends the run failed with the error, and its begun rejects", async () => {
  const dir = made();
  const run = await acpRuntime(rowFor(dir)).start(agentIn(), "[fail]");
  await expect(run.begun).rejects.toThrow();
  const end = await run.ended;
  expect(end.ok).toBe(false);
  expect(end.why).toContain("boom");
  expect(end.usage).toBeUndefined();
});

test("stop ends a hung run cancelled and failed, its adapter gone, its session no longer running", async () => {
  const dir = made();
  const rt = acpRuntime(rowFor(dir));
  const run = await rt.start(agentIn(), "[hang]");
  expect(await rt.state(run.ref)).toBe("running");
  await rt.stop(run.ref);
  expect(await run.ended).toEqual({ ok: false, why: "cancelled" });
  expect(isGone(logOf(dir)[0]?.pid ?? 0)).toBe(true);
  expect(await rt.state(run.ref)).toBe("idle");
});

test("a run that ends with no update never began, though a resume replayed one; its end is ok", async () => {
  const dir = made();
  const rt = acpRuntime(rowFor(dir));
  const first = await rt.start(agentIn(), "[answer]");
  await first.ended;
  const run = await rt.send(agentIn(), first.ref, "[silent]");
  await expect(run.begun).rejects.toThrow("before the turn began");
  expect((await run.ended).ok).toBe(true);
});

test("a live run reads running and refuses a second send; two sends racing across the state read launch one; after its end a send works", async () => {
  const dir = made();
  const rt = acpRuntime(rowFor(dir));
  const first = await rt.start(agentIn(), "[hang]");
  expect(await rt.state(first.ref)).toBe("running");
  await expect(rt.send(agentIn(), first.ref, "[answer]")).rejects.toThrow(
    "is running"
  );
  await rt.stop(first.ref);
  await first.ended;
  const sends = await Promise.allSettled([
    rt.send(agentIn(), first.ref, "[hang]"),
    rt.send(agentIn(), first.ref, "[hang]"),
  ]);
  expect(sends.map((s) => s.status).toSorted()).toEqual([
    "fulfilled",
    "rejected",
  ]);
  expect(logOf(dir).filter((l) => l.resume)).toHaveLength(1);
  await rt.stop(first.ref);
  await Promise.all(
    sends.flatMap((s) => (s.status === "fulfilled" ? [s.value.ended] : []))
  );
  const again = await rt.send(agentIn(), first.ref, "[answer]");
  expect((await again.ended).ok).toBe(true);
});

test("an adapter killed mid-turn (a desk restart) ends the run failed; a new runtime reads the session from its row", async () => {
  const dir = made();
  const run = await acpRuntime(rowFor(dir)).start(agentIn(), "[hang]");
  process.kill(logOf(dir)[0]?.pid ?? 0, "SIGKILL");
  expect(await run.ended).toEqual({ ok: false, why: "ACP connection closed" });
  const after = acpRuntime(rowFor(dir, () => Promise.resolve("gone")));
  expect(await after.state(run.ref)).toBe("gone");
});

test("the door's tool is approved; a shell call holding its prefix and any other tool are refused; no elicitation is declared", async () => {
  const dir = made();
  const run = await acpRuntime(rowFor(dir)).start(agentIn(), "[door]");
  expect((await run.ended).ok).toBe(true);
  const lines = logOf(dir);
  expect(lines.filter((l) => l.asked).map((l) => [l.asked, l.outcome])).toEqual(
    [
      ["mcp__desk__set_wait", { optionId: "yes", outcome: "selected" }],
      [
        "Run: echo mcp__desk__set_wait",
        { optionId: "no", outcome: "selected" },
      ],
      ["Edit a file", { optionId: "no", outcome: "selected" }],
    ]
  );
  const init = lines[0]?.initialize as {
    clientCapabilities: Record<string, unknown>;
  };
  expect(init.clientCapabilities.elicitation).toBeUndefined();
});

test("an adapter that never answers fails the launch within the limit, and is killed", async () => {
  const dir = made();
  const rt = acpRuntime(rowFor(dir), 3000);
  await expect(rt.start(agentIn("stall"), "[answer]")).rejects.toThrow(
    "did not answer within"
  );
  await Bun.sleep(100);
  expect(isGone(logOf(dir)[0]?.pid ?? 0)).toBe(true);
});

/** A desk whose one runtime is the fake agent's; `brief` steers it. */
function deskWith(brief: string) {
  const t = setup();
  const dir = made();
  t.desk.runtimes = { fake: acpRuntime(rowFor(dir)) };
  const id = register(t.desk, { brief, folder: tmpdir(), runtime: "fake" });
  return { ...t, dir, id };
}

test("through the desk: a first turn that never begins ends its agent not started after the begin limit, its adapter gone", async () => {
  const { desk, dir, id } = deskWith("Test brief [hang]");
  await wakeDue(desk);
  advance(BEGIN_WITHIN_MS + MIN);
  await tick(desk, false);
  expect(
    desk.db
      .query("select status, why_not_started from agent where id = ?")
      .get(id)
  ).toEqual({
    status: "ended",
    why_not_started: "it did not begin within 5 minutes",
  });
  await Bun.sleep(300);
  expect(isGone(logOf(dir)[0]?.pid ?? 0)).toBe(true);
});

test("through the desk: a failed first turn's why reaches the store", async () => {
  const { desk, id } = deskWith("Test brief [fail]");
  await wakeDue(desk);
  await Bun.sleep(1500);
  const row = desk.db
    .query<{ why_not_started: string | null }, [string]>(
      "select why_not_started from agent where id = ?"
    )
    .get(id);
  expect(row?.why_not_started).toContain("boom");
  expect(doorOf(id).key).toBeString();
});
