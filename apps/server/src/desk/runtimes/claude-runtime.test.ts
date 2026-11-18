import { expect, test } from "bun:test";
import { doorOf } from "../desk-door";
import { argsOf, usageOf } from "./claude-runtime";

// The claude runtime's pure parts: the command it runs, and a transcript's usage. Made-up transcripts.

test("the claude runtime puts the door's key in the environment, never the command line", () => {
  const door = doorOf("agt_0123456789ab");
  const a = { door, folder: "/tmp", id: "agt_0123456789ab", title: "Test" };
  const argv = [
    ...argsOf(a, "hello", { start: "u-1" }),
    ...argsOf(a, "again", { resume: "u-1" }),
  ];
  expect(argv.join(" ")).not.toContain(door.key);
  expect(argv.join(" ")).toContain("${LIFE_DESK_KEY}");
  expect(argsOf(a, "again", { resume: "u-1" }).slice(0, 4)).toEqual([
    "claude",
    "-p",
    "--resume",
    "u-1",
  ]);
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
