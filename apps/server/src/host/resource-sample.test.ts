import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readResourceSamples } from "../memory/run-log";
import { agentPidsOf, groupsOf, parsePs, systemOf } from "./resource-sample";

const PS = `
    1     0   0.0   1000 /sbin/launchd
  100     1   2.0  51200 /Applications/Life.app/Contents/MacOS/Life
  101   100  10.5 102400 /Applications/Life.app/Contents/Helpers/life watch
  102   101   4.5  20480 /usr/bin/git status
  103   100   1.0  10240 /Applications/Life.app/Contents/Helpers/life desk
  104   103  30.0 204800 node claude-agent-acp
  105   104   5.0  10240 /bin/zsh -c ls
  200     1   1.0  10240 /Applications/Lifelog Host.app/Contents/MacOS/Lifelog Host
  201   200  20.0 409600 /Applications/Lifelog Host.app/Contents/Helpers/llama/llama-server --embedding --port 8091
  202   200   3.0  51200 /Applications/Lifelog Host.app/Contents/Helpers/lifelog-server
  300     1   0.5  40960 /Users/x/.venv/bin/python -m synapse.app.homeserver -c homeserver.yaml
  301     1   0.2  20480 /Users/x/bridges/mautrix-whatsapp -c config.yaml
  400     1  50.0 999999 /Applications/Safari.app/Contents/MacOS/Safari
`;

test("a process counts under its nearest named ancestor; an agent's runtime and its tools under the agent; anything else is left out", () => {
  const agents = agentPidsOf(
    "  104 node claude-agent-acp HOME=/x LIFE_DESK_AGENT=agt_0a0a\n  105 /bin/zsh -c ls LIFE_DESK_AGENT=agt_0a0a\n"
  );
  expect(groupsOf(parsePs(PS), agents)).toEqual({
    "agent.agt_0a0a": [35, 210],
    "bridge.whatsapp": [0.2, 20],
    embedder: [20, 400],
    homeserver: [0.5, 40],
    "life.app": [2, 50],
    "life.desk": [1, 10],
    "life.watch": [15, 120],
    "voice.host": [1, 10],
    "voice.lifelog-server": [3, 50],
  });
});

test("the system's side of a sample, from its tools' own words", () => {
  expect(
    systemOf({
      batt: "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t87%; charging; 0:40 remaining",
      df: "Filesystem 1024-blocks Used Available Capacity\n/dev/disk3s1 976000000 500000000 97656250 84% /",
      load: "{ 3.10 2.50 2.00 }",
      pressure: "System-wide memory free percentage: 41%",
      swap: "total = 2048.00M  used = 1024.50M  free = 1023.50M  (encrypted)",
      therm: "Note: No thermal warning level has been recorded",
    })
  ).toEqual({
    battery: 87,
    diskFreeGb: 100,
    load: [3.1, 2.5, 2],
    memFree: 41,
    power: "ac",
    swapMb: 1025,
    thermal: "nominal",
  });
});

test("the last hour of samples is read back from the end of the log, oldest first, never older lines", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-samples-"));
  const now = new Date("2026-11-21T10:30:00.000Z");
  const sample = (time: string, load: number) =>
    JSON.stringify({
      category: ["life", "watch", "sample"],
      kind: "resource.sample",
      level: "info",
      load: [load, 0, 0],
      msg: "resource sample",
      time,
    });
  writeFileSync(
    join(dir, "2026-11-21.jsonl"),
    `${[
      sample("2026-11-21T09:00:00.000Z", 1),
      sample("2026-11-21T09:45:00.000Z", 2),
      JSON.stringify({ kind: "mcp.call", time: "2026-11-21T10:00:00.000Z" }),
      sample("2026-11-21T10:29:00.000Z", 3),
    ].join("\n")}\n{"time":"2026-11-21T10:29:30`
  );
  const read = readResourceSamples(now, dir);
  expect(read.hour.map((s) => (s.load as number[])[0])).toEqual([2, 3]);
  expect(read.latest).toEqual({
    load: [3, 0, 0],
    time: "2026-11-21T10:29:00.000Z",
  });
});
