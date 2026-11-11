import { expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendJsonl } from "../core/files";
import { Imported } from "../records/observation";
import { exportsDir } from "../sources/assistants";
import { IMPORTED } from "./ledger";
import { fetchOf } from "./words";

test("fetch gives an imported conversation back whole, dropped ones too, both sides verbatim, a page at a time", async () => {
  const dir = exportsDir("claude");
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  const turn = (i: number, sender: string, text: string) => ({
    created_at: `2026-03-02T09:0${i}:00.000Z`,
    sender,
    text,
    uuid: `t${i}`,
  });
  writeFileSync(
    join(dir, "conversations.json"),
    JSON.stringify([
      {
        chat_messages: [
          turn(0, "human", "Fix this:\n```\nls\n```"),
          turn(1, "assistant", "Run it twice.\nThen check."),
          turn(2, "human", "x".repeat(60_000)),
          turn(3, "assistant", "Done."),
        ],
        name: "A shell bug",
        updated_at: "2026-03-02T10:00:00.000Z",
        uuid: "w1",
      },
    ])
  );
  appendJsonl(IMPORTED, Imported, [
    {
      at: "2026-03-03T00:00:00.000Z",
      conversation: "claude:w1",
      keep: false,
      madeBy: { engine: "claude", model: "m", prompt: "import.v1", run: "r" },
      schemaVersion: 1,
      why: "Only code.",
    },
  ]);
  const first = await fetchOf("claude:w1", 0, 2);
  expect(first).toContain(
    'Conversation with Claude: "A shell bug" (claude:w1), not kept: Only code.: 1–2 of 4'
  );
  // Both sides, verbatim; newlines kept with continuation lines indented.
  expect(first).toContain("Fix this:\n  ```\n  ls\n  ```");
  expect(first).toContain("Claude: Run it twice.\n  Then check.");
  expect(first).toContain("(more: fetch claude:w1 --from-turn 2)");
  // The long message stands alone on its page, clipped and said so; the next page goes on after it.
  const long = await fetchOf("claude:w1", 2, 200);
  expect(long).toContain("3–3 of 4");
  expect(long).toContain("(clipped: ");
  expect(long).toContain("(more: fetch claude:w1 --from-turn 3)");
  expect(await fetchOf("claude:w1", 3, 200)).toContain("Claude: Done.");
  expect(await fetchOf("claude:nope")).toContain(
    "(no conversation claude:nope)"
  );
});
