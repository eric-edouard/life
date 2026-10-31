import { expect, test } from "bun:test";
import { AGENT_WORD } from "@life/server/src/core/names";
import { askAt, askTable, checked, holds } from "./bench-agent";

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
    ask: "entry_000000000000",
    call: [{ args: { kind: "add", title: "ploy" }, tool: "change_todo_item" }],
    contain: [],
    fetch: ["unit_aaaaaaaaaaaa", "unit_bbbbbbbbbbbb"],
    id: "ploy",
    not: { call: ["correct_memory"], contain: [] },
    outcome: "",
  };
  const calls: Parameters<typeof checked>[1] = [
    { ids: ["unit_aaaaaaaaaaaa"], tool: "search" },
    {
      args: { kind: "add", title: "Call Ploy" },
      error: true,
      tool: "change_todo_item",
    },
  ];
  expect(checked(c, calls)).toEqual([
    ["fetch unit_aaaaaaaaaaaa", true],
    ["fetch unit_bbbbbbbbbbbb", false],
    ['call change_todo_item {"kind":"add","title":"ploy"}', false],
    ["no correct_memory", true],
  ]);
  // The refused call made again, and a forbidden one.
  calls.push({
    args: { kind: "add", title: "Call Ploy" },
    tool: "change_todo_item",
  });
  calls.push({ tool: "correct_memory" });
  expect(checked(c, calls).map(([, ok]) => ok)).toEqual([
    true,
    false,
    true,
    false,
  ]);
});

test("the table: one row per case, what failed named, an error kept", () => {
  const out = askTable(
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

test("an ask as it reached Orbit: a heard one is the ask event, its line kept; a chat one is his words, the ledger before it", () => {
  const ask = (id: string, via: string, quote: string, at: string) =>
    JSON.stringify({
      after: { confidence: "high" },
      at,
      id,
      instruction: { at, quote, ref: `session:${at}` },
      kind: "ask",
      result: "ok",
      schemaVersion: 1,
      target: AGENT_WORD,
      via,
      why: "asked",
    });
  const lines = [
    ask(
      "entry_aaaaaaaaaaaa",
      "watch",
      "remind me to call the bank",
      "2026-10-20T08:00:00.000Z"
    ),
    ask(
      "entry_bbbbbbbbbbbb",
      "connector",
      "what is due today?",
      "2026-10-20T09:00:00.000Z"
    ),
  ];
  const heard = askAt(lines, "entry_aaaaaaaaaaaa");
  expect(heard.at).toBe("2026-10-20T08:00:00.000Z");
  expect(heard.kept).toEqual(lines.slice(0, 1));
  expect(heard.input).toBe('An ask event from Life: {"kind":"ask"}');
  const chat = askAt(lines, "entry_bbbbbbbbbbbb");
  expect(chat.kept).toEqual(lines.slice(0, 1));
  expect(chat.input).toBe("His message in your chat: what is due today?");
  expect(() => askAt(lines, "entry_cccccccccccc")).toThrow("not an ask");
});
