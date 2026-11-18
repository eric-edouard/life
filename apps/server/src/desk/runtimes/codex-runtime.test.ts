import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doorOf } from "../desk-door";
import {
  codexArgsOf,
  codexRuntime,
  hasEvent,
  rolloutUsageOf,
} from "./codex-runtime";

// The codex runtime: the command it runs, a rollout's usage, and a start and a turn driven through a fake `codex` on
// the PATH (made-up events). Nothing runs the real Codex.

const a = {
  door: doorOf("agt_0123456789ab"),
  effort: null,
  folder: tmpdir(),
  id: "agt_0123456789ab",
  model: null,
  title: "Test",
};

test("the codex runtime puts the door's key in the environment, never the command line", () => {
  const argv = codexArgsOf(a, "u-1", "hello");
  expect(argv.join(" ")).not.toContain(a.door.key);
  expect(argv.slice(0, 5)).toEqual([
    "codex",
    "exec",
    "resume",
    "u-1",
    "--json",
  ]);
  expect(argv).toContain(`mcp_servers.desk.url=${JSON.stringify(a.door.url)}`);
  expect(argv).toContain(
    'mcp_servers.desk.bearer_token_env_var="LIFE_DESK_KEY"'
  );
  // The desk's tools only: `exec` would deny them unasked, and nothing else is approved.
  expect(argv).toContain(
    'mcp_servers.desk.default_tools_approval_mode="approve"'
  );
  expect(argv.slice(-2)).toEqual(["--", "hello"]);
  // His model and effort, when the agent has them; none leaves Codex's own.
  expect(argv).not.toContain("-m");
  expect(argv.join(" ")).not.toContain("model_reasoning_effort");
  const chosen = codexArgsOf(
    { ...a, effort: "low", model: "test-model" },
    "u-1",
    "x"
  );
  expect(chosen).toContain("test-model");
  expect(chosen).toContain('model_reasoning_effort="low"');
});

test("a run's events: a type is in when a whole line says so", () => {
  const events =
    '{"type":"thread.started"}\n{"type":"turn.started"}\n{"type":"item.complete';
  expect(hasEvent(events, "turn.started")).toBe(true);
  expect(hasEvent(events, "turn.completed")).toBe(false);
});

test("a rollout's usage: growth since its first call, the last turn's calls counted once each", () => {
  const count = (
    input: number,
    cached: number,
    out: number,
    total: number
  ) => ({
    payload: {
      info: {
        last_token_usage: {
          cached_input_tokens: cached,
          input_tokens: input,
          output_tokens: out,
        },
        total_token_usage: { total_tokens: total },
      },
      type: "token_count",
    },
    type: "event_msg",
  });
  const event = (type: string) => ({ payload: { type }, type: "event_msg" });
  const lines = [
    event("task_started"),
    count(28_000, 7000, 5, 100),
    count(28_000, 7000, 5, 100),
    event("task_complete"),
    event("task_started"),
    { payload: { info: null, type: "token_count" }, type: "event_msg" },
    count(30_000, 28_000, 7, 200),
    count(31_000, 30_000, 3, 300),
    event("task_complete"),
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
  expect(rolloutUsageOf(lines)).toEqual({
    grownBy: 3000,
    tokensCached: 58_000,
    tokensIn: 3000,
    tokensOut: 10,
  });
  expect(rolloutUsageOf("")).toBeNull();
});

/** A `codex` that answers `app-server` with a made-up thread and runs a turn from its message: "fail" exits 3 mid-turn, "never" exits 1 at once. */
function fakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const bin = join(dir, "codex");
  writeFileSync(
    bin,
    `#!/usr/bin/env bun
const [, , cmd, , , , ...rest] = process.argv;
if (cmd === "app-server") {
  for await (const c of Bun.stdin.stream()) {
    if (new TextDecoder().decode(c).includes('"id":2')) {
      console.log(JSON.stringify({ id: 2, result: { thread: { id: "th-fake-1" } } }));
    }
  }
} else if (cmd === "exec") {
  const message = process.argv.at(-1);
  await Bun.write(${JSON.stringify(join(dir, "seen.json"))}, JSON.stringify({ argv: process.argv.slice(2), key: process.env.LIFE_DESK_KEY, cwd: process.cwd() }));
  if (message === "never") process.exit(1);
  console.log('{"type":"thread.started","thread_id":"th-fake-1"}');
  console.log('{"type":"turn.started"}');
  await Bun.sleep(300);
  if (message === "fail") process.exit(3);
  console.log('{"type":"turn.completed","usage":{}}');
} else process.exit(2);
`
  );
  chmodSync(bin, 0o755);
  return {
    dir,
    seen: () => JSON.parse(readFileSync(join(dir, "seen.json"), "utf8")),
  };
}

test("a start makes the thread, runs its first turn with the key in the environment, and links it", async () => {
  const fake = fakeCodex();
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const s = await codexRuntime.start(a, "the brief");
    expect(s.ref).toBe("th-fake-1");
    expect(s.link).toBe("codex://threads/th-fake-1");
    await s.begun;
    expect(await s.ended).toEqual({ ok: true });
    const seen = fake.seen();
    expect(seen.key).toBe(a.door.key);
    expect(seen.argv).toContain("th-fake-1");
    expect(seen.argv.at(-1)).toBe("the brief");
    expect(await codexRuntime.block()).toBeUndefined();
  } finally {
    process.env.PATH = path;
  }
});

test("a turn that dies mid-way ended not ok; one that dies before it began never begun", async () => {
  const fake = fakeCodex();
  const path = process.env.PATH;
  process.env.PATH = `${fake.dir}:${path}`;
  try {
    const failing = await codexRuntime.send(a, "th-fake-1", "fail");
    await failing.begun;
    expect(await failing.ended).toEqual({ ok: false });
    const never = await codexRuntime.send(a, "th-fake-1", "never");
    await expect(never.begun).rejects.toThrow("before the turn began");
    expect(await never.ended).toEqual({ ok: false });
  } finally {
    process.env.PATH = path;
  }
});
