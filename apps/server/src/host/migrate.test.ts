import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSettings } from "./migrate";

/** A state folder holding `settings`, and a reader of what it holds after. */
function install(settings: object) {
  const state = mkdtempSync(join(tmpdir(), "life-migrate-"));
  const path = join(state, "settings.json");
  writeFileSync(path, JSON.stringify(settings));
  return { path, read: () => JSON.parse(readFileSync(path, "utf8")), state };
}

test("the core switches leave, every other key stays", () => {
  const { path, read, state } = install({
    conversationSummaries: true,
    endings: true,
    links: true,
    matters: true,
    mentionsRead: true,
    personal: { relationshipReads: {} },
    sources: ["told-life"],
    voiceNaming: true,
  });
  migrateSettings(state);
  expect(read()).toEqual({
    personal: { relationshipReads: {} },
    sources: ["told-life"],
    voiceNaming: true,
  });
  const done = readFileSync(path, "utf8");
  migrateSettings(state);
  expect(readFileSync(path, "utf8")).toBe(done);
});

test("a file in the new shape is never rewritten, and a missing one is left missing", () => {
  const { path, state } = install({ sources: [] });
  const before = readFileSync(path, "utf8");
  migrateSettings(state);
  expect(readFileSync(path, "utf8")).toBe(before);
  migrateSettings(join(state, "none"));
});
