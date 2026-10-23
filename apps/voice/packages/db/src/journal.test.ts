// Drizzle runs a migration only if its journal `when` is after the last one applied: two branches once both took
// index 38, and production would have skipped one silently. Every file is in the journal, `when` strictly rising.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { MIGRATIONS } from "./index";

test("every migration is in the journal, in rising order", async () => {
  const journal: { entries: { tag: string; when: number }[] } = await Bun.file(
    join(MIGRATIONS, "meta/_journal.json")
  ).json();
  const tags = new Set(journal.entries.map((e) => e.tag));
  const missing = [...new Bun.Glob("*.sql").scanSync(MIGRATIONS)].filter(
    (file) => !tags.has(file.slice(0, -".sql".length))
  );
  const unordered = journal.entries
    .filter((e, i) => i > 0 && e.when <= (journal.entries[i - 1]?.when ?? 0))
    .map((e) => e.tag);
  expect({ missing, unordered }).toEqual({ missing: [], unordered: [] });
});
