import { expect, setSystemTime, test } from "bun:test";
import { HOUR, MIN } from "../core/clock";
import { agentHealthOf, deskHealthOf, type HealthFacts } from "./agent-health";

// The agents' health on made-up facts: the 22 Nov 2026 case (a session held open in a second Claude app for hours while
// its wakes queued) is broken, said in plain words; a quiet agent is fine.

const NOT_LISTENING = /^Not listening: /;
const NOW = Date.UTC(2026, 10, 22, 12, 0);
setSystemTime(new Date(NOW));
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const fine: HealthFacts = {
  amber: [],
  app: { inGroup: true, listed: true },
  failedInARow: 0,
  notStarted: null,
  runtime: "claude",
  runtimeBlock: null,
  sessionOpenIn: null,
  sessionOpenSince: null,
  status: "waiting",
  waitingSince: null,
};

test("a quiet agent is fine; stopped or ended agents are not judged", () => {
  expect(agentHealthOf(fine, NOW)).toEqual({ verdict: "fine", why: [] });
  expect(
    agentHealthOf({ ...fine, runtimeBlock: "x", status: "stopped" }, NOW)
      .verdict
  ).toBe("fine");
});

test("held open in his Claude app for 11 hours with wakes queued is broken; a short hold with none queued needs attention", () => {
  const held = {
    ...fine,
    amber: ["session open in your Claude app"],
    sessionOpenIn: "claude_app" as const,
    sessionOpenSince: ago(11 * HOUR),
  };
  const broken = agentHealthOf({ ...held, waitingSince: ago(10 * HOUR) }, NOW);
  expect(broken.verdict).toBe("broken");
  expect(broken.why).toHaveLength(1);
  expect(broken.why[0]).toStartWith("Open in your Claude app since ");
  expect(agentHealthOf(held, NOW).verdict).toBe("attention");
});

test("not listening, a blocked runtime, three failures, not in its group: each said once, broken first", () => {
  expect(
    agentHealthOf({ ...fine, waitingSince: ago(45 * MIN) }, NOW).verdict
  ).toBe("attention");
  const h = agentHealthOf(
    {
      ...fine,
      amber: ["last turn failed", "default wait"],
      app: { inGroup: false, listed: true },
      failedInARow: 3,
      runtimeBlock: "claude --version failed: 1",
      waitingSince: ago(3 * HOUR),
    },
    NOW
  );
  expect(h.verdict).toBe("broken");
  expect(h.why).toEqual([
    "claude can't run: claude --version failed: 1",
    "Its last 3 turns failed.",
    expect.stringMatching(NOT_LISTENING),
    "Its last turn ended without saying what it waits for.",
    "Not in the Life Agents group of your Claude app.",
  ]);
});

test("the desk: off, a standing role missing, the plugin off", () => {
  expect(
    deskHealthOf({ desk: "off", helper: "running", missingRoles: [] }).verdict
  ).toBe("broken");
  expect(
    deskHealthOf({
      desk: "ok",
      helper: "running",
      isPluginOn: false,
      missingRoles: ["caretaker"],
    })
  ).toEqual({
    verdict: "broken",
    why: [
      "No caretaker: your complaints have no one to fix them.",
      "The Life plugin is off in Claude Code: an agent's session you open by hand has no send guard.",
    ],
  });
  expect(
    deskHealthOf({ desk: "ok", helper: "running", missingRoles: [] })
  ).toEqual({ verdict: "fine", why: [] });
});
