import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { gogCall, gogJson, googleAccountsOf } from "./gog";
import { SECRETS, writeSecret } from "./secret";

const VAR = "GOG_KEYRING_PASSWORD";
const CLIENT = "GOG_CLIENT";
let had: string | undefined;
let hadClient: string | undefined;
beforeEach(() => {
  had = process.env[VAR];
  hadClient = process.env[CLIENT];
  delete process.env[VAR];
  delete process.env[CLIENT];
  rmSync(SECRETS.gogKeyring, { force: true });
});
afterEach(() => {
  rmSync(SECRETS.gogKeyring, { force: true });
  if (had === undefined) {
    delete process.env[VAR];
  } else {
    process.env[VAR] = had;
  }
  if (hadClient === undefined) {
    delete process.env[CLIENT];
  } else {
    process.env[CLIENT] = hadClient;
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

test("the keyring is always a file and the client is Life's, unless the process names its own", () => {
  const [, { env }] = gogCall("calendar", "a", []);
  expect(env.GOG_KEYRING_BACKEND).toBe("file");
  expect(env.GOG_CLIENT).toBe("life");
  process.env[CLIENT] = "his-own";
  expect(gogCall("calendar", "a", [])[1].env.GOG_CLIENT).toBe("his-own");
});

test("a call that names no account leaves it out; the sign-in keeps its prompts", () => {
  expect(gogCall("auth", undefined, ["list", "--check"])[0]).toEqual([
    "gog",
    "auth",
    "list",
    "--check",
    "--json",
    "--no-input",
  ]);
  expect(
    gogCall("auth", undefined, ["add", "ana@example.test"])[0]
  ).not.toContain("--no-input");
});

test("an account is what gog reports: its address, its check, its services and scopes", () => {
  expect(
    googleAccountsOf({
      accounts: [
        {
          email: "ana@example.test",
          scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
          services: ["gmail", "calendar"],
          valid: true,
        },
        { email: "bo@example.test", valid: false },
        { services: ["gmail"] },
      ],
    })
  ).toEqual([
    {
      address: "ana@example.test",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      services: ["gmail", "calendar"],
      valid: true,
    },
    {
      address: "bo@example.test",
      scopes: [],
      services: [],
      valid: false,
    },
  ]);
  expect(googleAccountsOf({})).toEqual([]);
});

test("a gog call's answer is parsed; a failure or a kill is gog's own words", async () => {
  const run = (answer: object) =>
    (() =>
      Promise.resolve({ code: 0, stderr: "", stdout: "", ...answer })) as never;
  expect(
    await gogJson("auth", undefined, ["list"], run({ stdout: '{"a":1}' }))
  ).toEqual({ a: 1 });
  // gog says nothing: an empty answer, not a crash.
  expect(await gogJson("auth", undefined, ["list"], run({}))).toEqual({});
  await expect(
    gogJson(
      "auth",
      undefined,
      ["list"],
      run({ code: 1, stderr: " invalid_grant " })
    )
  ).rejects.toThrow("invalid_grant");
  // A call killed before it answered is a failure too: its stdout is the words when stderr says nothing.
  await expect(
    gogJson(
      "auth",
      undefined,
      ["list"],
      run({ killed: "SIGTERM", stdout: "too slow" })
    )
  ).rejects.toThrow("too slow");
});
