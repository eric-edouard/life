import { expect, test } from "bun:test";
import { AGENT_WORD } from "server/src/core/names";
import { askAt, checked, holds, table } from "./bench-agent";

test("a call holds the wanted arguments: text as a case-blind part, anything else equal", () => {
  const args = {
    due: "2026-10-21 09:00",
    kind: "add",
    list: ["a"],
    title: "Call Ploy",
  };
  expect(holds(args, { kind: "add", title: "ploy" })).toBe(true);
  expect(holds(args, { due: "2026-10-21 09" })).toBe(true);
  expect(holds(args, { list: ["a"] })).toBe(true);
  expect(holds(args, { title: "notary" })).toBe(false);
  expect(holds(args, { list: ["b"] })).toBe(false);
});

test("the code's checks: ids cited, calls made without error, tools never called", () => {
  const c = {
    ask: "act_000000000000",
    call: [{ args: { kind: "add", title: "ploy" }, tool: "reminders" }],
    contain: [],
    fetch: ["u_aaaaaaaaaaaa", "u_bbbbbbbbbbbb"],
    id: "ploy",
    not: { call: ["correct"], contain: [] },
    outcome: "",
  };
  const calls: Parameters<typeof checked>[1] = [
    { ids: ["u_aaaaaaaaaaaa"], tool: "search" },
    {
      args: { kind: "add", title: "Call Ploy" },
      error: true,
      tool: "reminders",
    },
  ];
  expect(checked(c, calls)).toEqual([
    ["fetch u_aaaaaaaaaaaa", true],
    ["fetch u_bbbbbbbbbbbb", false],
    ['call reminders {"kind":"add","title":"ploy"}', false],
    ["no correct", true],
  ]);
  // The refused call made again, and a forbidden one.
  calls.push({ args: { kind: "add", title: "Call Ploy" }, tool: "reminders" });
  calls.push({ tool: "correct" });
  expect(checked(c, calls).map(([, ok]) => ok)).toEqual([
    true,
    false,
    true,
    false,
  ]);
});

test("the table: one row per case, what failed named, an error kept", () => {
  const out = table(
    [
      {
        calls: 4,
        chars: 1200,
        checks: [
          ["fetch x", true],
          ["no reminders", false],
        ],
        id: "a",
        minutes: 2,
      },
      { error: "index: boom", id: "b" },
    ],
    "run"
  );
  expect(out).toContain("1/2 checks passed.");
  expect(out).toContain("| a | 1/2 | 4 | 1200 | 2 min | no reminders |");
  expect(out).toContain("| b | error |||| index: boom |");
});

test("an ask as it reached Orbit: a delivered one is its event, its line kept; a chat one is his words, the ledger before it", () => {
  const ask = (id: string, madeBy: string, quote: string, at: string) =>
    JSON.stringify({
      after: { confidence: "high" },
      at,
      id,
      instruction: { at, quote, ref: `session:${at}` },
      kind: "ask",
      madeBy,
      result: "ok",
      schemaVersion: 1,
      target: AGENT_WORD,
      why: "asked",
    });
  const lines = [
    ask(
      "act_aaaaaaaaaaaa",
      "watch",
      "remind me to call the bank",
      "2026-10-20T08:00:00.000Z"
    ),
    ask(
      "act_bbbbbbbbbbbb",
      "connector",
      "what is due today?",
      "2026-10-20T09:00:00.000Z"
    ),
  ];
  const heard = askAt(lines, "act_aaaaaaaaaaaa");
  expect(heard.at).toBe("2026-10-20T08:00:00.000Z");
  expect(heard.kept).toEqual(lines.slice(0, 1));
  const event = JSON.parse(heard.input.replace("An ask event from Life: ", ""));
  expect([event.eventId, event.data.quote]).toEqual([
    "act_aaaaaaaaaaaa",
    "remind me to call the bank",
  ]);
  const chat = askAt(lines, "act_bbbbbbbbbbbb");
  expect(chat.kept).toEqual(lines.slice(0, 1));
  expect(chat.input).toBe("His message in your chat: what is due today?");
  expect(() => askAt(lines, "act_cccccccccccc")).toThrow("not an ask");
});
