import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResourceSamples } from "../memory/run-log";
import { groupsOf, parsePs, systemOf } from "./resource-sample";

// As `ps -Eaxww` shows them: the arguments, then the environment.
const PS = `
    1     0   0.0   1000 /sbin/launchd
  100     1   2.0  51200 /Applications/Life.app/Contents/MacOS/Life HOME=/x
  101   100  10.5 102400 /Applications/Life.app/Contents/Helpers/life watch HOME=/x
  102   101   4.5  20480 /usr/bin/git status HOME=/x
  103   100   1.0  10240 /Applications/Life.app/Contents/Helpers/life desk HOME=/x
  104   103  30.0 204800 node claude-agent-acp HOME=/x LIFE_DESK_AGENT=agt_0a0a0a0a0a0a
  105   104   5.0  10240 /bin/zsh -c ls HOME=/x LIFE_DESK_AGENT=agt_0a0a0a0a0a0a
  106   100   1.0  10240 /Applications/Life.app/Contents/Helpers/life-foundation-model HOME=/x
  200     1   1.0  10240 /Applications/Lifelog Host.app/Contents/MacOS/Lifelog Host HOME=/x
  201   200  20.0 409600 /Applications/Lifelog Host.app/Contents/Helpers/llama/llama-server --embedding --port 8091 HOME=/x
  202   200   3.0  51200 /Applications/Lifelog Host.app/Contents/Helpers/lifelog-server HOME=/x
  203   200   6.0  81920 /Users/x/Library/Application Support/Lifelog Host/identity/venv/bin/python3 /Applications/Lifelog Host.app/Contents/Resources/identity/app.py HOME=/x
  300     1   0.5  40960 .venv/bin/python -m synapse.app.homeserver -c homeserver.yaml LIFE_BRIDGE=synapse
  301     1   0.2  20480 ./bridge -c config.yaml LIFE_BRIDGE=whatsapp
  400     1  50.0 999999 /Applications/Safari.app/Contents/MacOS/Safari HOME=/x
  401     1   9.0  10240 /opt/bin/rg life-entry.ts docs /Applications/Life.app/Contents/Helpers/life watch HOME=/x
  402     1   9.0  10240 /usr/bin/grep LIFE_DESK_AGENT=agt_0b0b0b0b0b0b ./bridge -c config.yaml HOME=/x
  403     1   9.0  10240 /usr/bin/grep Life.app/Contents/Helpers/life watch LIFE_BRIDGE=whatsapp HOME=/x
`;

test("a process counts under its nearest named program, an agent's tools under the agent; a program that only names one of Life's is left out", () => {
  expect(groupsOf(parsePs(PS))).toEqual({
    "agent.agt_0a0a0a0a0a0a": [35, 210],
    "bridge.whatsapp": [0.2, 20],
    embedder: [20, 400],
    foundation: [1, 10],
    homeserver: [0.5, 40],
    "life.app": [2, 50],
    "life.desk": [1, 10],
    "life.watch": [15, 120],
    "voice.host": [1, 10],
    "voice.identity": [6, 80],
    "voice.lifelog-server": [3, 50],
  });
});

test("the system's side of a sample, from its tools' own words; a tool that failed is null, a true 0 stays", () => {
  expect(
    systemOf({
      batt: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t87%; charging; 0:40 remaining",
      df: "Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s1 976000000 500000000 97656250 84% /",
      load: "{ 3.10 2.50 2.00 }",
      pressure: "System-wide memory free percentage: 0%",
      swap: "total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)",
      therm: "Note: No thermal warning level has been recorded",
    })
  ).toEqual({
    battery: 87,
    diskFreeGb: 100,
    load: [3.1, 2.5, 2],
    memFree: 0,
    power: "ac",
    swapMb: 1025,
    thermal: "nominal",
  });
  expect(
    systemOf({
      batt: null,
      df: null,
      load: null,
      pressure: null,
      swap: null,
      therm: null,
    })
  ).toEqual({
    battery: null,
    diskFreeGb: null,
    load: null,
    memFree: null,
    power: null,
    swapMb: null,
    thermal: null,
  });
});

test("the last hour of samples is read back from the end of the log, across midnight and blocks, oldest first; never older or later lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-samples-"));
  const now = new Date("2026-11-21T00:20:00.000Z");
  const sample = (time: string, load: number) =>
    JSON.stringify({
      category: ["life", "watch", "sample"],
      kind: "resource.sample",
      level: "info",
      load: [load, 0, 0],
      msg: "resource sample",
      time,
    });
  // A line bigger than a read's block, with letters of two bytes, so a block's edge falls inside a line.
  const wide = JSON.stringify({
    kind: "mcp.call",
    time: "2026-11-20T23:50:00.000Z",
    x: "é".repeat(40_000),
  });
  writeFileSync(
    join(dir, "2026-11-20.jsonl"),
    `${[
      sample("2026-11-20T23:00:00.000Z", 1),
      sample("2026-11-20T23:45:00.000Z", 2),
      wide,
      sample("2026-11-20T23:59:00.000Z", 3),
    ].join("\n")}\n`
  );
  writeFileSync(
    join(dir, "2026-11-21.jsonl"),
    `${[
      sample("2026-11-21T00:10:00.000Z", 4),
      sample("2026-11-21T00:20:00.001Z", 5),
    ].join("\n")}\n{"time":"2026-11-21T00:19:30`
  );
  const read = readResourceSamples(now, dir);
  expect(read.hour.map((s) => (s.load as number[])[0])).toEqual([2, 3, 4]);
  expect(read.latest).toEqual({
    load: [4, 0, 0],
    time: "2026-11-21T00:10:00.000Z",
  });
});
