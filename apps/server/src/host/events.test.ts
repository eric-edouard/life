import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { appendJsonl, linesOf } from "../core/files";
import { recentEvents } from "../core/log";
import { AGENT_WORD } from "../core/names";
import { LIFE_STATE_DIR } from "../core/paths";
import { HOME } from "../core/platform";
import { SECRETS, writeSecret } from "../core/secret";
import { readSettings, type Settings, setSettings } from "../core/settings";
import { LEDGER } from "../memory/ledger";
import { action } from "../memory/record-fixtures";
import { zoneNow } from "../memory/zones";
import { LedgerEntry } from "../records/ledger-entry";
import {
  agentLive,
  askCursor,
  hasNewAsk,
  startAgent,
  startOnAsk,
} from "./events";

test("a new ask past the cursor is one he made, not one the agent made from a chat; other lines are passed over", () => {
  const line = (over: Parameters<typeof action>[0]) =>
    JSON.stringify(action({ kind: "ask", target: AGENT_WORD, ...over }));
  const heard = line({ via: "watch" });
  const chat = line({ via: "connector" });
  const other = line({ kind: "update" });
  expect(hasNewAsk([heard, other], 0)).toBe(true);
  expect(hasNewAsk([heard, other], 1)).toBe(false);
  expect(hasNewAsk([chat, other], 0)).toBe(false);
});

test("an agent is live while it reads tasks: a day without a call is a lapse", async () => {
  const before = readSettings().agent as NonNullable<Settings["agent"]>;
  const now = Date.parse("2026-10-22T10:00:00Z");
  const call = (tool: string, hours: number, agent = "openai-mcp/1") => ({
    agent,
    at: new Date(now - hours * HOUR).toISOString(),
    tool,
  });
  try {
    setSettings({ agent: before });
    expect(
      await agentLive(now, async () => [call("read_open_agent_tasks", 2)])
    ).toBe(true);
    expect(
      await agentLive(now, async () => [call("read_open_agent_tasks", 30)])
    ).toBe(false);
    expect(await agentLive(now, async () => [call("read_day", 2)])).toBe(false);
    expect(
      await agentLive(now, async () => [
        call("read_open_agent_tasks", 2, "curl/8"),
      ])
    ).toBe(false);
  } finally {
    setSettings({ agent: before });
  }
});

test('a new heard ask starts a pulling agent\'s command once with {kind:"ask"}, never one made from a chat, and a tick passes its own event; the cursor moves to the end', async () => {
  const before = readSettings().agent as NonNullable<Settings["agent"]>;
  const marker = join(LIFE_STATE_DIR, "started");
  const cmd = [
    process.execPath,
    "-e",
    `require("fs").appendFileSync(${JSON.stringify(marker)}, process.argv.at(-1) + "\\n")`,
  ];
  // The command runs on its own: wait up to `ms` for it to write `want` times (a loaded machine starts it late).
  const started = async (want: number, ms = 5000) => {
    const count = () => events().length;
    for (let waited = 0; count() < want && waited < ms; waited += 50) {
      // biome-ignore lint/performance/noAwaitInLoops: polling a file the child writes
      await Bun.sleep(50);
    }
    // Then a little longer, so a second start would show.
    await Bun.sleep(300);
    return count();
  };
  const events = () =>
    existsSync(marker)
      ? readFileSync(marker, "utf8").split("\n").filter(Boolean)
      : [];
  rmSync(SECRETS.events, { force: true });
  rmSync(marker, { force: true });
  mkdirSync(HOME, { recursive: true });
  writeSecret("events", JSON.stringify({ delivered: 0 }));
  try {
    setSettings({ agent: { ...before, start: cmd } });
    appendJsonl(LEDGER, LedgerEntry, [
      action({ kind: "ask", target: AGENT_WORD, via: "connector" }),
    ]);
    startOnAsk();
    expect(await started(1, 500)).toBe(0);
    appendJsonl(LEDGER, LedgerEntry, [
      action({ kind: "ask", target: AGENT_WORD }),
    ]);
    startOnAsk();
    startOnAsk();
    expect(await started(1)).toBe(1);
    expect(JSON.parse(events()[0] ?? "null")).toEqual({
      kind: "ask",
      zone: zoneNow(),
    });
    expect(askCursor()).toBe(linesOf(LEDGER).length);
    startAgent({
      at: "2026-10-29T00:00:00.000Z",
      kind: "tick",
    });
    expect(await started(2)).toBe(2);
    expect(JSON.parse(events()[1] ?? "null")).toEqual({
      at: "2026-10-29T00:00:00.000Z",
      kind: "tick",
      zone: zoneNow(),
    });
  } finally {
    setSettings({ agent: before });
    rmSync(LEDGER, { force: true });
    rmSync(SECRETS.events, { force: true });
    rmSync(marker, { force: true });
  }
});

test("what the agent's starter says as it exits non-zero is mailed, each line once however often it says it", async () => {
  const before = readSettings().agent as NonNullable<Settings["agent"]>;
  const said = "2026-10-29: a loop missed its run due at 02:30.";
  const cmd = [
    process.execPath,
    "-e",
    `console.error(${JSON.stringify(said)}); process.exit(2)`,
  ];
  mkdirSync(HOME, { recursive: true });
  const subjects: string[] = [];
  const post = spyOn(globalThis, "fetch").mockImplementation(((
    _url: string,
    init: RequestInit
  ) => {
    subjects.push(JSON.parse(String(init.body)).subject);
    return Promise.resolve(Response.json({ id: `email_${subjects.length}` }));
  }) as unknown as typeof fetch);
  process.env.RESEND_PERSONAL_API_KEY = "test";
  const mailed = async () =>
    (await recentEvents<{ key: string }>(1, "email.sent")).filter((e) =>
      e.key.startsWith("agent-start/")
    );
  try {
    setSettings({ agent: { ...before, start: cmd } });
    startAgent({ at: "2026-10-29T09:00:00.000Z", kind: "tick" });
    startAgent({ at: "2026-10-29T09:01:00.000Z", kind: "tick" });
    // The child runs on its own: wait for its mail (a loaded machine is slow).
    for (let waited = 0; subjects.length === 0 && waited < 5000; waited += 50) {
      // biome-ignore lint/performance/noAwaitInLoops: polling for the child's mail
      await Bun.sleep(50);
    }
    await Bun.sleep(500);
    expect(await mailed()).toHaveLength(1);
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toContain("missed its run");
  } finally {
    post.mockRestore();
    delete process.env.RESEND_PERSONAL_API_KEY;
    setSettings({ agent: before });
  }
});

test("his answer on his page wakes the loop that asked; his Something's wrong starts the audit; opening the context or revoking wakes none", async () => {
  const { wakeOf } = await import("./events");
  expect(wakeOf("answered", "lynx-store")).toEqual({
    kind: "decision",
    loop: "lynx-store",
  });
  expect(wakeOf("context", "lynx-store")).toBeUndefined();
  expect(wakeOf("revoked", "lynx-store")).toBeUndefined();
  expect(wakeOf("answered", undefined)).toBeUndefined();
  expect(wakeOf("asked", "lynx-store")).toEqual({ kind: "audit" });
});
