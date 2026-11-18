import { expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_AGENT_OFF, CODEX_HOME, CODEX_OFF } from "../../models/llm";
import { doorOf } from "../desk-door";
import {
  isRolloutTurnOpen,
  isTurnOpen,
  readProgram,
  runtimeRowsOf,
} from "./runtime-rows";

// The runtime rows as data: what each program is given, and how each reads a session's state. Made-up transcripts.

const a = {
  door: doorOf("agt_0123456789ab"),
  effort: null,
  folder: tmpdir(),
  id: "agt_0123456789ab",
  model: null,
  title: "Test",
};

test("the rows put the door's key in the environment, never in a command; each names the adapter, the model and the effort", () => {
  for (const isOwn of [true, false]) {
    for (const row of Object.values(runtimeRowsOf(isOwn))) {
      const { command, env } = row.spawn({
        ...a,
        effort: "low",
        model: "test-model",
      });
      expect(command[0]).toBe(process.execPath);
      expect(command.join(" ")).not.toContain(a.door.key);
      expect(env.BUN_BE_BUN).toBe("1");
    }
  }
  const { claude, codex } = runtimeRowsOf(true);
  expect(claude.spawn(a).env.LIFE_DESK_KEY).toBe(a.door.key);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: what Claude expands from the adapter's environment
  expect(claude.header(a.door.key)).toBe("Bearer ${LIFE_DESK_KEY}");
  expect(codex.header(a.door.key)).toBe(`Bearer ${a.door.key}`);
  expect(codex.spawn(a).env.LIFE_DESK_KEY).toBeUndefined();
  expect(
    JSON.parse(
      codex.spawn({ ...a, effort: "low", model: "test-model" }).env
        .CODEX_CONFIG ?? ""
    )
  ).toEqual({
    model: "test-model",
    model_reasoning_effort: "low",
  });
  expect(JSON.parse(codex.spawn(a).env.CODEX_CONFIG ?? "")).toEqual({});
  expect([claude.doorPrefix, codex.doorPrefix]).toEqual([
    "mcp__desk__",
    "mcp.desk.",
  ]);
});

test("a second Life's agent takes none of his settings, tools or instruction files: its door alone; his own runs as he set the programs up", () => {
  const rows = runtimeRowsOf(false);
  expect(rows.claude.meta).toMatchObject({
    claudeCode: {
      options: {
        allowedTools: ["mcp__desk"],
        settingSources: [],
        strictMcpConfig: true,
        tools: [],
      },
    },
  });
  expect(rows.claude.meta).toMatchObject({
    claudeCode: { options: { permissionMode: "default" } },
  });
  const { env } = rows.claude.spawn(a);
  expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
  expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe("1");
  expect(rows.claude.handOff).toBeUndefined();
  const second = JSON.parse(rows.codex.spawn(a).env.CODEX_CONFIG ?? "");
  expect(second.project_doc_max_bytes).toBe(0);
  for (const f of [...CODEX_OFF, ...CODEX_AGENT_OFF]) {
    expect(second.features[f]).toBe(false);
  }
  expect(second.web_search).toBe("disabled");
  expect(second.skills.include_instructions).toBe(false);
  expect(rows.codex.spawn(a).env.CODEX_HOME).toBe(CODEX_HOME);
  const his = runtimeRowsOf(true);
  expect(his.claude.meta).toBeUndefined();
  expect(
    his.claude.spawn(a).env.CLAUDE_CODE_DISABLE_AUTO_MEMORY
  ).toBeUndefined();
  expect(his.codex.spawn(a).env.CODEX_HOME).toBeUndefined();
  expect(JSON.parse(his.codex.spawn(a).env.CODEX_CONFIG ?? "")).toEqual({});
});

test("a session held by an idle process is not running: only an open last turn is", () => {
  const said = (stop: string | null) => ({
    message: { content: [{ type: "text" }], stop_reason: stop },
    type: "assistant",
  });
  const prompt = { message: { content: "Woken" }, type: "user" };
  const transcript = (...entries: object[]) =>
    entries.map((e) => JSON.stringify(e)).join("\n");
  // The Claude app's warm process after a finished turn: the desk may wake the agent.
  expect(isTurnOpen(transcript(prompt, said("end_turn")))).toBe(false);
  expect(isTurnOpen(transcript(prompt, said("stop_sequence")))).toBe(false);
  expect(
    isTurnOpen(
      transcript(prompt, said("end_turn"), {
        isSidechain: true,
        ...said("tool_use"),
      })
    )
  ).toBe(false);
  expect(
    isTurnOpen(
      transcript(prompt, said("tool_use"), {
        message: {
          content: [{ text: "[Request interrupted by user]", type: "text" }],
        },
        type: "user",
      })
    )
  ).toBe(false);
  // His turn, still running: a prompt, a tool call, a tool's result, a message with no stop reason yet.
  expect(isTurnOpen(transcript(said("end_turn"), prompt))).toBe(true);
  expect(isTurnOpen(transcript(prompt, said("tool_use")))).toBe(true);
  expect(
    isTurnOpen(
      transcript(prompt, said("tool_use"), {
        message: { content: [{ type: "tool_result" }] },
        type: "user",
      })
    )
  ).toBe(true);
  expect(isTurnOpen(transcript(prompt, said(null)))).toBe(true);
  expect(
    isTurnOpen(`${transcript(prompt, said("end_turn"))}\n{"type":"us`)
  ).toBe(true);
  expect(isTurnOpen("")).toBe(false);
});

test("a codex session is running while its rollout's last turn is open and fresh (his own turn in the app); a compressed rollout is not gone", async () => {
  const dir = join(CODEX_HOME, "sessions", "2026", "01", "01");
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
  write("ref-half", "jsonl", [ev("task_started"), '{"type":"event_ms'], 1);
  const row = runtimeRowsOf(false).codex;
  expect(await row.readSessionState("ref-open-fresh")).toBe("running");
  expect(await row.readSessionState("ref-open-stale")).toBe("idle");
  expect(await row.readSessionState("ref-done")).toBe("idle");
  expect(await row.readSessionState("ref-packed")).toBe("idle");
  expect(await row.readSessionState("ref-none")).toBe("gone");
  // A half-written last line never throws.
  expect(await row.readSessionState("ref-half")).toBe("running");
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
