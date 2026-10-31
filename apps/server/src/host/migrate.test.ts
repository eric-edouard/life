import { expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "../core/clock";
import { logFileOf } from "../core/log";
import { Settings } from "../core/settings";
import { migrateStored } from "./migrate";

// Made-up memory and state from before agents had names: Orbit, the one agent.
const ledger = [
  {
    after: { confidence: "high", title: "book the dentist" },
    id: "a1",
    kind: "ask",
  },
  { after: { state: "done" }, id: "u1", kind: "update" },
  { after: { agent: "Comet", confidence: "high" }, id: "a2", kind: "ask" },
];
const decisions = [
  {
    at: "2026-10-30T10:00:00.000Z",
    data: {},
    decision: "dec_1",
    step: "asked",
  },
  {
    at: "2026-10-30T11:00:00.000Z",
    data: { answer: "yes" },
    decision: "dec_1",
    step: "answered",
  },
  {
    at: "2026-10-30T10:00:00.000Z",
    data: {},
    decision: "fact-checks-obs_1",
    step: "asked",
  },
];
const settings = {
  agent: {
    client: "claude-code",
    misheard: ["or bit"],
    name: "Orbit",
    start: ["orbit-run"],
    transport: "pull",
    wake: ["orbit"],
  },
  sources: [],
};
const oauth = {
  clients: {},
  refresh: {
    h1: { client: "c1", expires: 1 },
    h2: { agent: "Comet", client: "c2", expires: 2 },
    h3: { client: "c3", expires: 3 },
  },
};

const jsonl = (rows: unknown[]) =>
  `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`;

test("the one agent's name is stamped on its asks, decisions and the pairings of apps that called as it; lines keep their place; run twice, nothing changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-migrate-"));
  const state = join(dir, "state");
  mkdirSync(join(dir, "memory"), { recursive: true });
  mkdirSync(join(state, "oauth"), { recursive: true });
  writeFileSync(join(dir, "memory/ledger.jsonl"), jsonl(ledger));
  writeFileSync(join(dir, "memory/decisions.jsonl"), jsonl(decisions));
  writeFileSync(join(state, "settings.json"), JSON.stringify(settings));
  writeFileSync(join(state, "oauth/state.json"), JSON.stringify(oauth), {
    mode: 0o600,
  });
  // c1 called as the agent (its user agent starts with the old `client`), c3 as a plain app.
  mkdirSync(join(state, "log"));
  writeFileSync(
    join(state, "log", logFileOf(clock().toISOString())),
    jsonl([
      { agent: "claude-code/2.1", at: "x", client: "c1", kind: "mcp.call" },
      { agent: "Claude-User", at: "x", client: "c3", kind: "mcp.call" },
    ])
  );
  const read = (p: string) => readFileSync(join(dir, p), "utf8");
  const rows = (p: string) =>
    read(p)
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));

  await migrateStored(dir, state);
  const once = [
    "memory/ledger.jsonl",
    "memory/decisions.jsonl",
    "state/settings.json",
    "state/oauth/state.json",
  ].map(read);

  expect(rows("memory/ledger.jsonl").map((r) => r.after.agent)).toEqual([
    "Orbit",
    undefined,
    "Comet",
  ]);
  // An untouched line keeps its bytes.
  expect(read("memory/ledger.jsonl").split("\n")[1]).toBe(
    JSON.stringify(ledger[1])
  );
  expect(rows("memory/decisions.jsonl").map((r) => r.agent)).toEqual([
    "Orbit",
    undefined,
    undefined,
  ]);
  const now = JSON.parse(read("state/settings.json"));
  expect(now).toEqual({
    agents: {
      Orbit: {
        misheard: ["or bit"],
        start: { command: ["orbit-run"], on: ["tick", "message"] },
        wake: ["orbit"],
      },
    },
    sources: [],
  });
  expect(() => Settings.parse(now)).not.toThrow();
  const pairings = JSON.parse(read("state/oauth/state.json"));
  expect(pairings.refresh.h1.agent).toBe("Orbit");
  expect(pairings.refresh.h2.agent).toBe("Comet");
  expect(pairings.refresh.h3.agent).toBeUndefined();
  expect(statSync(join(state, "oauth/state.json")).mode.toString(8)).toEndWith(
    "600"
  );
  expect(rows("memory/migrations.jsonl").map((r) => r.name)).toEqual([
    "agents-2026-10-31",
  ]);

  await migrateStored(dir, state);
  expect(
    [
      "memory/ledger.jsonl",
      "memory/decisions.jsonl",
      "state/settings.json",
      "state/oauth/state.json",
    ].map(read)
  ).toEqual(once);
  expect(rows("memory/migrations.jsonl")).toHaveLength(1);
});
