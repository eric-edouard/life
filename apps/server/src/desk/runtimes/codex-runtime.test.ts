import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { linesOf } from "../../core/files";
import { DESK_RUNS } from "../../core/paths";
import { CODEX_HOME } from "../../models/llm";
import { doorOf } from "../desk-door";
import {
  codexArgsOf,
  codexRuntime,
  hasEvent,
  hasModelItem,
  isRolloutTurnOpen,
  readCodexHome,
  rolloutUsageOf,
} from "./codex-runtime";
import { readProgram } from "./contract";

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

test("a second Life's agent (not his own) takes none of his config, rules, instruction files, skills or shell: its door alone; his own runs as before", () => {
  const second = codexArgsOf(a, "u-1", "hello", false);
  for (const flag of [
    "--ignore-user-config",
    "--ignore-rules",
    "shell_tool",
    "plugins",
    'sandbox_mode="read-only"',
    "project_doc_max_bytes=0",
    "skills.include_instructions=false",
  ]) {
    expect(second).toContain(flag);
  }
  // Its door still reaches it.
  expect(second).toContain(
    `mcp_servers.desk.url=${JSON.stringify(a.door.url)}`
  );
  const his = codexArgsOf(a, "u-1", "hello", true);
  expect(his).not.toContain("--ignore-user-config");
  expect(his).not.toContain("--disable");
  expect(his.join(" ")).not.toContain("project_doc_max_bytes");
});

test("a run's events: a type is in when a whole line says so", () => {
  const events = [
    '{"type":"thread.started"}',
    '{"type":"turn.started"}',
    '{"type":"item.complete',
  ];
  expect(hasEvent(events, "turn.started")).toBe(true);
  expect(hasEvent(events, "turn.completed")).toBe(false);
  // Not by substring: an agent's message that mentions the event.
  expect(
    hasEvent(['{"type":"item","text":"turn.completed"}'], "turn.completed")
  ).toBe(false);
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
    // A line half written by a turn running now is skipped, never thrown.
    .concat('{"type":"event_ms');
  expect(rolloutUsageOf(lines)).toEqual({
    grownBy: 3000,
    tokensCached: 58_000,
    tokensIn: 3000,
    tokensOut: 10,
  });
  expect(rolloutUsageOf([])).toBeNull();
});

/** Resolves once `isTrue` holds, looked at every few milliseconds (the fake's own events, written by another process). */
async function until(isTrue: () => boolean) {
  while (!isTrue()) {
    // biome-ignore lint/performance/noAwaitInLoops: waits for another process's file
    await Bun.sleep(5);
  }
}

/**
 * A `codex` in `/bin/sh` on the PATH: `--version` answers, `app-server` gives a made-up thread, and a turn prints its
 * events from its message: "never" exits 1 at once, "quick" begins and ends at once, "hang" is launched and never
 * answers; any other begins (the model's first item), then waits for the test's `release()` (a `go` file) and ends,
 * exiting 3 for "fail". What a turn was given is kept in files.
 */
function fakeCodex() {
  const dir = mkdtempSync(join(tmpdir(), "fake-codex-"));
  const bin = join(dir, "codex");
  const go = join(dir, "go");
  // Its own thread id: the runtime asks the whole Mac (`pgrep`) whether a process holds it, and other runs may be there.
  const thread = `th-${basename(dir)}`;
  writeFileSync(
    bin,
    `#!/bin/sh
case "$1" in
--version) echo "codex-cli 0.0.0-fake" ;;
app-server)
  while read -r line; do
    case "$line" in *'"id":2'*) echo '{"id":2,"result":{"thread":{"id":"${thread}"}}}' ;; esac
  done ;;
exec)
  for m; do :; done
  printf '%s\\n' "$@" > '${dir}/argv'
  printf '%s' "$LIFE_DESK_KEY" > '${dir}/key'
  printf '%s' "$CODEX_HOME" > '${dir}/home'
  [ "$m" = never ] && exit 1
  echo '{"type":"thread.started","thread_id":"${thread}"}'
  echo '{"type":"turn.started"}'
  [ "$m" = hang ] || echo '{"type":"item.started","item":{"type":"agent_message"}}'
  if [ "$m" != quick ]; then
    while [ ! -e '${go}' ]; do sleep 0.01; done
    rm -f '${go}'
  fi
  [ "$m" = fail ] && exit 3
  echo '{"type":"turn.completed","usage":{}}' ;;
*) exit 2 ;;
esac
`
  );
  chmodSync(bin, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  return {
    argv: () => read("argv").split("\n").slice(0, -1),
    home: () => read("home"),
    key: () => read("key"),
    release: () => writeFileSync(go, ""),
    thread,
    [Symbol.dispose]: () => {
      process.env.PATH = path;
    },
  };
}

test("a start makes the thread, runs its first turn with the key in the environment, and links it; block asks the codex on the PATH", async () => {
  using fake = fakeCodex();
  const s = await codexRuntime.start(a, "the brief");
  expect(s.ref).toBe(fake.thread);
  expect(s.link).toBe(`codex://threads/${fake.thread}`);
  await s.begun;
  fake.release();
  expect(await s.ended).toEqual({ ok: true });
  expect(fake.key()).toBe(a.door.key);
  // A test's Life is a copy: its agent runs in Life's own Codex home, never his.
  expect(fake.home()).toBe(CODEX_HOME);
  expect(fake.argv()).toContain(fake.thread);
  expect(fake.argv().at(-1)).toBe("the brief");
  expect(await codexRuntime.block()).toBeUndefined();
});

test("a turn that dies mid-way ended not ok; one that dies before it began never begun; one that begins and ends at once began", async () => {
  using fake = fakeCodex();
  const failing = await codexRuntime.send(a, fake.thread, "fail");
  await failing.begun;
  fake.release();
  expect(await failing.ended).toEqual({ ok: false });
  const never = await codexRuntime.send(a, fake.thread, "never");
  await expect(never.begun).rejects.toThrow("before the turn began");
  expect(await never.ended).toEqual({ ok: false });
  // Its events file is read for `begun` before it goes.
  const quick = await codexRuntime.send(a, fake.thread, "quick");
  await quick.begun;
  expect(await quick.ended).toEqual({ ok: true });
});

test("a session is running while its rollout's last turn is open and fresh (his own turn in the app); a compressed rollout is not gone", async () => {
  const dir = join(readCodexHome(), "sessions", "2026", "01", "01");
  mkdirSync(dir, { recursive: true });
  const ev = (type: string) =>
    JSON.stringify({ payload: { type }, type: "event_msg" });
  const write = (ref: string, ext: string, lines: string[], ageMin: number) => {
    const path = join(dir, `rollout-2026-01-01T00-00-00-${ref}.${ext}`);
    const text = `${lines.join("\n")}\n`;
    writeFileSync(
      path,
      ext.endsWith("zst") ? Bun.zstdCompressSync(text) : text
    );
    const at = new Date(Date.now() - ageMin * 60_000);
    utimesSync(path, at, at);
  };
  expect(isRolloutTurnOpen([ev("task_started")])).toBe(true);
  expect(isRolloutTurnOpen([ev("task_started"), ev("task_complete")])).toBe(
    false
  );
  expect(isRolloutTurnOpen([ev("task_started"), ev("turn_aborted")])).toBe(
    false
  );
  write("ref-open-fresh", "jsonl", [ev("task_started")], 1);
  write("ref-open-stale", "jsonl", [ev("task_started")], 30);
  write("ref-done", "jsonl", [ev("task_started"), ev("task_complete")], 1);
  write(
    "ref-packed",
    "jsonl.zst",
    [ev("task_started"), ev("task_complete")],
    20_000
  );
  expect(await codexRuntime.state("ref-open-fresh")).toBe("running");
  expect(await codexRuntime.state("ref-open-stale")).toBe("idle");
  expect(await codexRuntime.state("ref-done")).toBe("idle");
  expect(await codexRuntime.state("ref-packed")).toBe("idle");
  expect(await codexRuntime.state("ref-none")).toBe("gone");
  // A half-written last line never throws.
  write("ref-half", "jsonl", [ev("task_started"), '{"type":"event_ms'], 1);
  expect(await codexRuntime.usage("ref-half")).toBeNull();
});

test("a run begins at the model's first item, not at turn.started; stop ends a hung run and forgets its events; a restart reads begun from the run's file", async () => {
  using fake = fakeCodex();
  expect(hasModelItem(['{"type":"turn.started"}'])).toBe(false);
  expect(
    hasModelItem(['{"type":"turn.started"}', '{"type":"item.started"}'])
  ).toBe(true);
  await codexRuntime.send(a, fake.thread, "hang");
  // Launched, `turn.started` written, no answer: not begun, and its record says so.
  await until(() =>
    [...new Bun.Glob(`${fake.thread}-*.jsonl`).scanSync(DESK_RUNS)].some((f) =>
      hasEvent(linesOf(join(DESK_RUNS, f)), "turn.started")
    )
  );
  expect(await codexRuntime.hasBegun(fake.thread)).toBe(false);
  await codexRuntime.stop(fake.thread);
  // Its process is gone and its events forgotten. (Its `ended` is not awaited: Bun may miss a killed detached child's
  // exit; the desk ends the turn before it stops the run, so nothing waits on it.)
  expect(
    Bun.spawnSync(["pgrep", "-f", `exec resume ${fake.thread}`]).exitCode
  ).toBe(1);
  expect([...new Bun.Glob(`${fake.thread}-*`).scanSync(DESK_RUNS)]).toEqual([]);
  const going = await codexRuntime.send(a, fake.thread, "go on");
  await going.begun;
  expect(await codexRuntime.hasBegun(fake.thread)).toBe(true);
  fake.release();
  expect(await going.ended).toEqual({ ok: true });
});

test("the desk launches the program on the PATH, never one in node_modules/.bin (Life's pinned Codex under `bun run`)", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-path-"));
  const pinned = join(dir, "node_modules", ".bin");
  const his = join(dir, "his");
  for (const d of [pinned, his]) {
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "codex"), "#!/bin/sh\n");
    chmodSync(join(d, "codex"), 0o755);
  }
  const path = process.env.PATH;
  process.env.PATH = `${pinned}:${his}:${path}`;
  try {
    expect(readProgram("codex")).toBe(join(his, "codex"));
  } finally {
    process.env.PATH = path;
  }
});
