import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { importOf } from "../sources/assistants";
import { dryRun, importExport, parseJudged } from "./imports";

// A made-up claude.ai export: one conversation about his life, one only code.
const exportOf = (text: string) => [
  {
    chat_messages: [
      {
        created_at: "2026-03-02T09:15:00.000Z",
        sender: "human",
        text,
        uuid: "m1",
      },
    ],
    name: "Ada's move",
    uuid: "c1",
  },
  {
    chat_messages: [
      {
        created_at: "2026-03-03T10:00:00.000Z",
        sender: "human",
        text: "```ts\nthrow new Error()\n```",
        uuid: "m2",
      },
    ],
    name: "A bug",
    uuid: "c2",
  },
];

const folderWith = (json: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "export-"));
  writeFileSync(join(dir, "conversations.json"), JSON.stringify(json));
  return dir;
};

test("the dry run counts an export's conversations and days", () => {
  const s = dryRun(folderWith(exportOf("My sister Ada moves to Lyon in May.")));
  expect([
    s.source,
    s.conversations,
    s.messages,
    s.days,
    s.from,
    s.calls,
  ]).toEqual(["claude", { all: 2, kept: 1 }, 1, 1, "2026-03-02", 1]);
});

test("a judging reply is checked: one line per conversation asked about", () => {
  const judged = parseJudged(
    {
      conversations: [
        { id: "c1", keep: true, why: "His sister's move." },
        { id: "c1", keep: false, why: "Again." },
        { id: "zz", keep: true, why: "Not asked." },
      ],
    },
    new Set(["c1"]),
    {
      at: "2026-10-21T00:00:00.000Z",
      madeBy: { engine: "codex", model: "m", prompt: "import.v1", run: "r" },
      source: "claude",
    }
  );
  expect(judged.invalid).toBe(2);
  expect(judged.records.map((r) => [r.conversation, r.keep])).toEqual([
    ["claude:c1", true],
  ]);
});

test("another export of the same assistant is refused before any model call", async () => {
  const to = importOf("claude");
  mkdirSync(dirname(to), { recursive: true });
  writeFileSync(to, JSON.stringify(exportOf("An older export.")));
  await expect(
    importExport(folderWith(exportOf("A newer one.")))
  ).rejects.toThrow("holds another Claude export already");
});
