import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { gogCall } from "./gog";
import { SECRETS, writeSecret } from "./secret";

const VAR = "GOG_KEYRING_PASSWORD";
let had: string | undefined;
beforeEach(() => {
  had = process.env[VAR];
  delete process.env[VAR];
  rmSync(SECRETS.gogKeyring, { force: true });
});
afterEach(() => {
  rmSync(SECRETS.gogKeyring, { force: true });
  if (had === undefined) {
    delete process.env[VAR];
  } else {
    process.env[VAR] = had;
  }
});

test("the command line is the one both callers built before", () => {
  expect(gogCall("calendar", "a@example.test", ["events", "c"])[0]).toEqual([
    "gog",
    "calendar",
    "events",
    "c",
    "--account=a@example.test",
    "--json",
    "--no-input",
  ]);
  expect(
    gogCall("tasks", "a@example.test", ["lists", "list"])[0].slice(0, 3)
  ).toEqual(["gog", "tasks", "lists"]);
});

test("the child gets the keyring password from its file when the process has none, trimmed", () => {
  writeSecret("gogKeyring", "made-up-password\n");
  expect(gogCall("tasks", "a", [])[1].env[VAR]).toBe("made-up-password");
});

test("the process's own variable wins over the file", () => {
  writeSecret("gogKeyring", "from-file");
  process.env[VAR] = "from-shell";
  expect(gogCall("tasks", "a", [])[1].env[VAR]).toBe("from-shell");
});

test("no file and no variable leaves the environment as it is", () => {
  expect(gogCall("tasks", "a", [])[1].env[VAR]).toBeUndefined();
});
