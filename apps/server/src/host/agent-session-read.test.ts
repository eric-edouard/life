import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piSessionFileOf, readSessionLines } from "./agent-session-read";

// A made-up pi session file read as his app shows it: what Life sent, the agent's words, its tool calls and their
// answers, a compaction's summary; its thinking and pi's own entries left out; a line pi is still writing skipped.

const at = "2026-11-22T10:00:00.000Z";
const entries = [
  { cwd: "/made/up", id: "s1", timestamp: at, type: "session" },
  {
    id: "1",
    message: { content: "Your brief.", role: "user" },
    parentId: null,
    timestamp: at,
    type: "message",
  },
  {
    id: "2",
    parentId: "1",
    thinkingLevel: "high",
    timestamp: at,
    type: "thinking_level_change",
  },
  {
    id: "3",
    message: {
      content: [
        { thinking: "hmm", type: "thinking" },
        { text: "I'll look.", type: "text" },
        {
          arguments: { command: "ls" },
          id: "c1",
          name: "bash",
          type: "toolCall",
        },
      ],
      role: "assistant",
    },
    parentId: "2",
    timestamp: at,
    type: "message",
  },
  {
    id: "4",
    message: {
      content: [{ text: "x".repeat(2500), type: "text" }],
      isError: true,
      role: "toolResult",
      toolName: "bash",
    },
    parentId: "3",
    timestamp: at,
    type: "message",
  },
  {
    firstKeptEntryId: "3",
    id: "5",
    parentId: "4",
    summary: "Looked at the folder",
    timestamp: at,
    tokensBefore: 9,
    type: "compaction",
  },
];

test("a pi session reads as asked, said, tool, result and summary lines, each cut", async () => {
  const sessions = mkdtempSync(join(tmpdir(), "life-pi-sessions-"));
  const file = join(sessions, "2026-11-22T10-00-00_ref-made.jsonl");
  writeFileSync(
    file,
    `${entries.map((e) => JSON.stringify(e)).join("\n")}\n{"type":"mess`
  );
  expect(piSessionFileOf(sessions, "ref-made")).toBe(file);
  expect(piSessionFileOf(sessions, "ref-other")).toBeUndefined();
  const lines = await readSessionLines(file);
  expect(
    lines.map((l) => [l.kind, l.tool ?? null, l.text.slice(0, 20)])
  ).toEqual([
    ["asked", null, "Your brief."],
    ["said", null, "I'll look."],
    ["tool", "bash", '{"command":"ls"}'],
    ["result", "bash", "xxxxxxxxxxxxxxxxxxxx"],
    ["summary", null, "Looked at the folder"],
  ]);
  expect(lines[3]).toMatchObject({ isError: true });
  expect(lines[3]?.text.length).toBe(2001);
});
