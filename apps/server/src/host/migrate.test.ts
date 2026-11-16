import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSettings } from "./migrate";

/** A state folder holding `settings`, and a data folder with or without a stored persona. */
function install(settings: object, hasPersona: boolean) {
  const root = mkdtempSync(join(tmpdir(), "life-migrate-"));
  const state = join(root, "state");
  const data = join(root, "data");
  mkdirSync(state);
  mkdirSync(join(data, "memory", "personas"), { recursive: true });
  if (hasPersona) {
    writeFileSync(join(data, "memory", "personas", "per_ana.json"), "{}");
  }
  writeFileSync(join(state, "settings.json"), JSON.stringify(settings));
  const read = () =>
    JSON.parse(readFileSync(join(state, "settings.json"), "utf8"));
  return { data, read, state };
}

test("the old keys move under personal, and personas stay on for an install that holds them", () => {
  const { data, read, state } = install(
    {
      exchangeReads: true,
      histories: { from: "2026-01" },
      sources: ["told-life"],
    },
    true
  );
  migrateSettings(state, data);
  expect(read()).toEqual({
    mentionsRead: true,
    personal: {
      aboutMe: {},
      histories: { from: "2026-01" },
      personas: {},
      relationshipReads: {},
      relationships: {},
    },
    sources: ["told-life"],
  });
  const done = readFileSync(join(state, "settings.json"), "utf8");
  migrateSettings(state, data);
  expect(readFileSync(join(state, "settings.json"), "utf8")).toBe(done);
});

test("an install with no persona gets only what it had on", () => {
  const { data, read, state } = install(
    { histories: { from: "2026-01" } },
    false
  );
  migrateSettings(state, data);
  expect(read()).toEqual({ personal: { histories: { from: "2026-01" } } });
});

test("a file already in the new shape, and a fresh install, are left as they are", () => {
  const added = { personal: { personas: {} } };
  const one = install(added, true);
  migrateSettings(one.state, one.data);
  expect(one.read()).toEqual(added);
  const removed = install({ sources: [] }, true);
  migrateSettings(removed.state, removed.data);
  expect(removed.read()).toEqual({ sources: [] });
  const fresh = install({ sources: [] }, false);
  migrateSettings(fresh.state, fresh.data);
  expect(fresh.read()).toEqual({ sources: [] });
  migrateSettings(join(fresh.state, "none"), fresh.data);
});
