import { expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN } from "../../core/clock";
import { register } from "../agent-actions";
import { BEGIN_WITHIN_MS } from "../agent-wait";
import { tick, wakeDue } from "../desk-clock";
import { doorOf } from "../door-keys";
import { advance, setup } from "../test-desk";
import { acpRuntime } from "./acp-runtime";
import type { Agent } from "./contract";
import type { Row } from "./runtime-rows";
import { LAUNCH_WITHIN_MS } from "./session-runtime";

// The ACP runtime against a made-up ACP agent (`fake-acp-agent.ts`), one case per rule the wait contract leans on.
// Nothing runs a real adapter.

// Each case starts a process: a loaded Mac needs more than the default 5 s.
setDefaultTimeout(30_000);

const FAKE = join(import.meta.dir, "fake-acp-agent.ts");

/** A row for the fake agent; its log is read by `logOf`. */
const rowFor = (
  dir: string,
  state: Row["readSessionState"] = () => Promise.resolve("idle"),
  own: Partial<Row> = { onlyDoorPrefix: "mcp__desk__" }
): Row => ({
  block: () => Promise.resolve(undefined),
  config: { effort: "effort", model: "model" },
  header: (key) => `Bearer ${key}`,
  link: (ref) => `fake://${ref}`,
  readSessionState: state,
  ...own,
  spawn: (a) =>
    Promise.resolve({
      // `dir` on the command line: `pgrep -f dir` finds this test's adapters, whatever they logged.
      command: [process.execPath, FAKE, dir],
      env: {
        FAKE_ACP_LOG: join(dir, "log.jsonl"),
        ...(a.title === "stall" ? { FAKE_ACP_STALL: "1" } : {}),
        ...(a.title === "no-mode" ? { FAKE_ACP_NO_MODE: "1" } : {}),
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
/** Whether an adapter started with `dir` on its command line is still running. */
const isRunning = (dir: string) =>
  Bun.spawnSync(["pgrep", "-f", dir]).exitCode === 0;
/** Waits for `isDone`, at most 10 s. */
const until = async (isDone: () => boolean) => {
  for (let i = 0; i < 200 && !isDone(); i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: a poll
    await Bun.sleep(50);
  }
};
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

test("a second Life's row: the door's tool is approved; a shell call holding its prefix and any other tool are refused; no elicitation is declared", async () => {
  const dir = made();
  const run = await acpRuntime(rowFor(dir)).start(agentIn(), "[door]");
  expect((await run.ended).ok).toBe(true);
  const lines = logOf(dir);
  expect(lines.filter((l) => l.asked).map((l) => [l.asked, l.outcome])).toEqual(
    [
      ["mcp__desk__set_wait", { optionId: "yes", outcome: "selected" }],
      ["mcp__desk__set_wait; curl x", { optionId: "no", outcome: "selected" }],
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
  expect(isRunning(dir)).toBe(false);
});

test("a spawn that fails (a missing folder) fails the start; it never hangs", async () => {
  const dir = made();
  await expect(
    acpRuntime(rowFor(dir)).start(
      { ...agentIn(), folder: join(dir, "missing") },
      "[answer]"
    )
  ).rejects.toThrow();
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
      .query(
        "select status, why_not_started from agent join assignment on agent_id = agent.id where agent.id = ?"
      )
      .get(id)
  ).toEqual({
    status: "ended",
    why_not_started: "it did not begin within 5 minutes",
  });
  await until(() => !isRunning(dir));
  expect(isRunning(dir)).toBe(false);
});

test("through the desk: a failed first turn's why reaches the store", async () => {
  const { desk, id } = deskWith("Test brief [fail]");
  await wakeDue(desk);
  const whyOf = () =>
    desk.db
      .query<{ why_not_started: string | null }, [string]>(
        "select why_not_started from assignment where agent_id = ?"
      )
      .get(id)?.why_not_started;
  await until(() => !!whyOf());
  const row = desk.db
    .query<{ why_not_started: string | null }, [string]>(
      "select why_not_started from assignment where agent_id = ?"
    )
    .get(id);
  expect(row?.why_not_started).toContain("boom");
  expect(doorOf(id).key).toBeString();
});

test("his own Life's row: every ask is approved, and the mode is set after new and after resume, before the prompt", async () => {
  const dir = made();
  const rt = acpRuntime(
    rowFor(dir, () => Promise.resolve("idle"), { mode: "no-ask-mode" })
  );
  const first = await rt.start(agentIn(), "[door]");
  expect((await first.ended).ok).toBe(true);
  const again = await rt.send(agentIn(), first.ref, "[door]");
  expect((await again.ended).ok).toBe(true);
  // Per run: the model, the effort, the mode, then the prompt.
  const kinds = kindsOf(dir);
  expect(kinds.filter((k) => k !== "asked")).toEqual([
    "initialize",
    "made",
    "config",
    "config",
    "config",
    "prompt",
    "initialize",
    "resume",
    "config",
    "config",
    "config",
    "prompt",
  ]);
  const lines = logOf(dir);
  expect(
    lines
      .filter((l) => l.config)
      .map((l) => (l.config as { configId: string }).configId)
  ).toEqual(["model", "effort", "mode", "model", "effort", "mode"]);
  expect(lines.filter((l) => l.asked).map((l) => [l.asked, l.outcome])).toEqual(
    [1, 2].flatMap(() =>
      ["mcp__desk__set_wait", "mcp__desk__set_wait; curl x", "Edit a file"].map(
        (t) => [t, { optionId: "yes", outcome: "selected" }]
      )
    )
  );
});

test("an adapter that refuses the mode: the turn still ends ok, and its asks are approved", async () => {
  const dir = made();
  const run = await acpRuntime(
    rowFor(dir, () => Promise.resolve("idle"), { mode: "no-ask-mode" })
  ).start(agentIn("no-mode"), "[door]");
  expect((await run.ended).ok).toBe(true);
  expect(
    logOf(dir)
      .filter((l) => l.asked)
      .map((l) => (l.outcome as { optionId: string }).optionId)
  ).toEqual(["yes", "yes", "yes"]);
});

test("talk: one process kept across prompts, its updates heard as they come, closed idle with nothing opened in his app; keep resumes it; stop closes it", async () => {
  const dir = made();
  const rt = acpRuntime(
    rowFor(dir, () => Promise.resolve("idle")),
    LAUNCH_WITHIN_MS,
    300
  );
  const heard: unknown[] = [];
  const first = await rt.talk(agentIn(), null, "[answer]", (u) =>
    heard.push(u)
  );
  expect((await first.ended).ok).toBe(true);
  expect(heard).toEqual([{ kind: "words", text: "ok" }]);
  expect(await rt.state(first.ref)).toBe("running");
  await expect(rt.send(agentIn(), first.ref, "[answer]")).rejects.toThrow(
    "is running"
  );
  const again = await rt.talk(agentIn(), first.ref, "[door]", () => undefined);
  expect(again.ref).toBe(first.ref);
  expect((await again.ended).ok).toBe(true);
  expect(kindsOf(dir).filter((k) => k !== "asked" && k !== "config")).toEqual([
    "initialize",
    "made",
    "prompt",
    "prompt",
  ]);
  expect(new Set(logOf(dir).map((l) => l.pid)).size).toBe(1);
  const pid = logOf(dir)[0]?.pid ?? 0;
  await until(() => isGone(pid));
  expect(isGone(pid)).toBe(true);
  expect(await rt.state(first.ref)).toBe("idle");
  await rt.keep(agentIn(), first.ref);
  expect(kindsOf(dir).at(-1)).toBe("config");
  expect(logOf(dir).filter((l) => l.resume)).toHaveLength(1);
  const kept = logOf(dir).at(-1)?.pid ?? 0;
  await rt.stop(first.ref);
  expect(isGone(kept)).toBe(true);
  expect(await rt.state(first.ref)).toBe("idle");
});

test("talk and keep racing open one process; a stopped kept session's old timer never drops the next one mid-answer; a ref switch while answering is refused", async () => {
  const dir = made();
  const rt = acpRuntime(rowFor(dir), LAUNCH_WITHIN_MS, 300);
  const first = await rt.talk(agentIn(), null, "[answer]", () => undefined);
  await first.ended;
  await rt.stop(first.ref);
  const [, run] = await Promise.all([
    rt.keep(agentIn(), first.ref),
    rt.talk(agentIn(), first.ref, "[hang]", () => undefined),
  ]);
  expect(logOf(dir).filter((l) => l.resume)).toHaveLength(1);
  await expect(rt.keep(agentIn(), "another-session")).rejects.toThrow(
    "is answering"
  );
  await Bun.sleep(600);
  expect(await rt.state(first.ref)).toBe("running");
  await rt.stop(first.ref);
  expect(await run.ended).toEqual({ ok: false, why: "cancelled" });
  expect(await rt.state(first.ref)).toBe("idle");
});

test("a stop while a send launches kills its adapter at once: the launch fails", async () => {
  const dir = made();
  const rt = acpRuntime(rowFor(dir));
  const launching = rt.send(agentIn("stall"), "fake-x", "[answer]");
  await until(() => isRunning(dir));
  const at = performance.now();
  await rt.stop("fake-x");
  await expect(launching).rejects.toThrow();
  expect(performance.now() - at).toBeLessThan(5000);
  await until(() => !isRunning(dir));
  expect(isRunning(dir)).toBe(false);
});
