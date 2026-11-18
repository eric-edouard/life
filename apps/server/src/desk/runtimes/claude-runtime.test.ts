import { expect, test } from "bun:test";
import { doorOf } from "../desk-door";
import { argsOf, hasBegun, isTurnOpen, usageOf } from "./claude-runtime";

// The claude runtime's pure parts: the command it runs, and a transcript's usage. Made-up transcripts.

test("the claude runtime puts the door's key in the environment, never the command line", () => {
  const door = doorOf("agt_0123456789ab");
  const a = {
    door,
    effort: null,
    folder: "/tmp",
    id: "agt_0123456789ab",
    model: null,
    title: "Test",
  };
  const argv = [
    ...argsOf(a, "hello", { start: "u-1" }),
    ...argsOf(a, "again", { resume: "u-1" }),
  ];
  expect(argv.join(" ")).not.toContain(door.key);
  // biome-ignore lint/suspicious/noTemplateCurlyInString: what Claude expands from the environment
  expect(argv.join(" ")).toContain("Bearer ${LIFE_DESK_KEY}");
  expect(argsOf(a, "again", { resume: "u-1" }).slice(0, 4)).toEqual([
    "claude",
    "-p",
    "--resume",
    "u-1",
  ]);
  // His model and effort, when the agent has them; none leaves Claude's own.
  const chosen = argsOf({ ...a, effort: "high", model: "test-model" }, "x", {
    resume: "u-1",
  });
  expect(chosen.slice(4, 8)).toEqual([
    "--model",
    "test-model",
    "--effort",
    "high",
  ]);
  expect(argsOf(a, "x", { resume: "u-1" })).not.toContain("--model");
});

test("a transcript's usage: growth since its first call, and its last turn's calls counted once each", () => {
  const usage = (id: string, input: number, read: number, out: number) => ({
    message: {
      id,
      usage: {
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: read,
        input_tokens: input,
        output_tokens: out,
      },
    },
    type: "assistant",
  });
  const lines = [
    { message: { content: "Test brief" }, type: "user" },
    usage("m1", 10, 30_000, 5),
    { message: { content: [{ text: "Woken", type: "text" }] }, type: "user" },
    usage("m2", 100, 40_000, 7),
    usage("m2", 100, 40_000, 7),
    { message: { content: [{ type: "tool_result" }] }, type: "user" },
    usage("m3", 50, 45_000, 3),
    { isSidechain: true, ...usage("s1", 1, 90_000, 1) },
  ]
    .map((l) => JSON.stringify(l))
    .join("\n");
  expect(usageOf(lines)).toEqual({
    grownBy: 45_050 - 30_010,
    tokensCached: 85_000,
    tokensIn: 150,
    tokensOut: 10,
  });
  expect(usageOf("")).toBeNull();
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

test("a turn has begun once its prompt is in an open transcript; a first turn done before anyone looked began too", () => {
  const prompt = JSON.stringify({
    message: { content: "Brief" },
    type: "user",
  });
  const done = `${prompt}\n${JSON.stringify({ message: { content: [{ type: "text" }], stop_reason: "end_turn" }, type: "assistant" })}`;
  // No transcript yet: not begun, over or not.
  expect(hasBegun(undefined, true, false)).toBe(false);
  expect(hasBegun(undefined, true, true)).toBe(false);
  // The prompt is in and the turn is open.
  expect(hasBegun(prompt, false, false)).toBe(true);
  // A resumed session's last turn is closed: the new prompt is not in yet, unless the run is a first turn.
  expect(hasBegun(done, false, false)).toBe(false);
  expect(hasBegun(done, false, true)).toBe(false);
  expect(hasBegun(done, true, false)).toBe(false);
  expect(hasBegun(done, true, true)).toBe(true);
});
