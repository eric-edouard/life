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
  askedAgents,
  startAgent,
  startOnAsk,
} from "./events";

test("a new ask past the cursor is one he made, not one an agent made from a chat, and names its agent; other lines are passed over", () => {
  const line = (over: Parameters<typeof action>[0]) =>
    JSON.stringify(action({ kind: "ask", target: AGENT_WORD, ...over }));
  const heard = line({ after: { agent: "Orbit" }, via: "watch" });
  const other = line({ after: { agent: "Comet" }, via: "watch" });
  const chat = line({ after: { agent: "Comet" }, via: "connector" });
  const update = line({ kind: "update" });
  expect([...askedAgents([heard, other, update], 0)]).toEqual([
    "Orbit",
    "Comet",
  ]);
  expect([...askedAgents([heard, update], 1)]).toEqual([]);
  expect([...askedAgents([chat, update], 0)]).toEqual([]);
});

test("an agent is live while it reads its tasks: a day without a call of its own is a lapse", async () => {
  const now = Date.parse("2026-10-22T10:00:00Z");
  const call = (tool: string, hours: number, agent = "Orbit") => ({
    agent,
    at: new Date(now - hours * HOUR).toISOString(),
    tool,
  });
  const live = (c: ReturnType<typeof call>) =>
    agentLive(now, "Orbit", async () => [c]);
  expect(await live(call("read_open_agent_tasks", 2))).toBe(true);
  expect(await live(call("read_open_agent_tasks", 30))).toBe(false);
  expect(await live(call("read_day", 2))).toBe(false);
  expect(await live(call("read_open_agent_tasks", 2, "Comet"))).toBe(false);
});

test("a new heard ask starts its agent's command once with {kind:\"ask\"}, never one made from a chat nor another agent's, and a tick passes its own event only to an agent started on ticks; the cursor moves to the end", async () => {
  const before = readSettings().agents as NonNullable<Settings["agents"]>;
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
  writeSecret("events", "{");
  try {
    const orbit = before.Orbit as NonNullable<(typeof before)["Orbit"]>;
    setSettings({
      agents: {
        ...before,
        Comet: { misheard: [], wake: ["comet"] },
        Orbit: { ...orbit, start: { command: cmd, on: [] } },
      },
    });
    startOnAsk();
    expect(askCursor()).toBe(linesOf(LEDGER).length);
    appendJsonl(LEDGER, LedgerEntry, [
      action({
        after: { agent: "Orbit" },
        kind: "ask",
        target: AGENT_WORD,
        via: "connector",
      }),
      action({ after: { agent: "Comet" }, kind: "ask", target: AGENT_WORD }),
    ]);
    startOnAsk();
    startAgent("Orbit", { at: "2026-10-29T00:00:00.000Z", kind: "tick" });
    expect(await started(1, 500)).toBe(0);
    setSettings({
      agents: {
        ...before,
        Orbit: { ...orbit, start: { command: cmd, on: ["tick"] } },
      },
    });
    appendJsonl(LEDGER, LedgerEntry, [
      action({ after: { agent: "Orbit" }, kind: "ask", target: AGENT_WORD }),
    ]);
    startOnAsk();
    startOnAsk();
    expect(await started(1)).toBe(1);
    expect(JSON.parse(events()[0] ?? "null")).toEqual({
      kind: "ask",
      zone: zoneNow(),
    });
    expect(askCursor()).toBe(linesOf(LEDGER).length);
    startAgent("Orbit", {
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
    setSettings({ agents: before });
    rmSync(LEDGER, { force: true });
    rmSync(SECRETS.events, { force: true });
    rmSync(marker, { force: true });
  }
});

test("what the agent's starter says as it exits non-zero is mailed, each line once however often it says it", async () => {
  const before = readSettings().agents as NonNullable<Settings["agents"]>;
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
    setSettings({
      agents: {
        ...before,
        Orbit: {
          ...(before.Orbit as NonNullable<(typeof before)["Orbit"]>),
          start: { command: cmd, on: ["tick"] },
        },
      },
    });
    startAgent("Orbit", { at: "2026-10-29T09:00:00.000Z", kind: "tick" });
    startAgent("Orbit", { at: "2026-10-29T09:01:00.000Z", kind: "tick" });
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
    setSettings({ agents: before });
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
