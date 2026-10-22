import { expect, test } from "bun:test";
import { DAY, HOUR, MIN } from "../../core/clock";
import { clientName } from "../events";
import { snapshot, stationsOf, toneOf, waking, wokeAt } from "./snapshot";

const now = Date.parse("2026-10-21T15:00:00.000Z");
const ago = (ms: number) => new Date(now - ms).toISOString();

test("a source is red only when Life can't read it; silence is quiet, then amber past its limit", () => {
  expect(toneOf(ago(10 * MIN), DAY, now)).toEqual({
    tone: "ok",
    word: "receiving",
  });
  expect(toneOf(ago(5 * HOUR), DAY, now)).toEqual({
    tone: "idle",
    word: "quiet",
  });
  expect(toneOf(ago(25 * HOUR), DAY, now)).toEqual({
    tone: "warn",
    word: "silent",
  });
  expect(toneOf(ago(MIN), DAY, now, false)).toEqual({
    tone: "bad",
    word: "unreadable",
  });
  expect(toneOf(null, DAY, now)).toEqual({ tone: "idle", word: "nothing yet" });
});

test("the Pendant is expected to hear him between 08:00 and 01:00 only", () => {
  const at = (h: number) => new Date(2026, 9, 21, h, 30);
  expect([7, 8, 13, 23, 0, 1, 4].map((h) => waking(at(h)))).toEqual([
    false,
    true,
    true,
    true,
    true,
    false,
    false,
  ]);
});

test("his waking hours began at 08:00, the day before after midnight: a night is not silence", () => {
  const at = (day: number, h: number) => new Date(2026, 9, day, h, 30);
  expect(wokeAt(at(21, 9))).toEqual(new Date(2026, 9, 21, 8, 0));
  expect(wokeAt(at(22, 0))).toEqual(new Date(2026, 9, 21, 8, 0));
  expect(wokeAt(at(22, 4))).toBeNull();
});

test("connector clients go by the names he knows them by", () => {
  expect(clientName("openai-mcp/1.0.0")).toBe("Orbit");
  expect(clientName("claude-ai/0.1")).toBe("Claude");
  expect(clientName("")).toBe("unknown client");
  expect(clientName("curl/8")).toBe("curl/8");
});

test("a sweep's stations are the phases it recorded: done, now, the one it failed at still to do, then the night's report", () => {
  const run = (phases: string[], outcome: string, failedAt?: string) =>
    ({ outcome, phases, result: failedAt ? { failedAt } : {} }) as never;
  const all = [
    "repos",
    "gather",
    "moments",
    "extract",
    "pages",
    "index",
    "actions",
    "commit",
  ];
  const ok = run(all, "ok");
  const state = (list: { name: string; state: string }[]) =>
    list.map((x) => `${x.name}:${x.state}`);
  expect(
    state(stationsOf({ lastOk: ok, latest: ok }, false, true)).slice(-3)
  ).toEqual(["actions:done", "commit:done", "email:done"]);
  const failed = run(
    [
      "repos",
      "gather",
      "moments",
      "extract",
      "pages",
      "index",
      "actions",
      "commit",
    ],
    "failed",
    "commit"
  );
  expect(
    state(stationsOf({ lastOk: ok, latest: failed }, false, false)).slice(-2)
  ).toEqual(["commit:todo", "email:todo"]);
  const running = run(["repos", "gather", "moments"], "running");
  expect(
    state(stationsOf({ lastOk: ok, latest: running }, true, null)).slice(1, 4)
  ).toEqual(["gather:done", "moments:now", "extract:todo"]);
});

test(
  "every card on the status snapshot has its own id",
  async () => {
    const ids = (await snapshot()).cards.map((c) => c.id);
    expect(ids.length).toBe(new Set(ids).size);
  },
  MIN
);

test(
  "an output's card says off when its switch is off, on when it is on",
  async () => {
    const cards = new Map((await snapshot()).cards.map((c) => [c.id, c]));
    // The made-up settings set a connector and no Past calendar.
    expect(cards.get("past")?.word).toBe("off");
    expect(cards.get("connector")?.word).toBe("serving");
  },
  MIN
);
