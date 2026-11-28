import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gogKeyringPassword } from "../core/gog";
import { SECRETS } from "../core/secret";
import { connectGoogle } from "./connect-google";

const ANA = "ana@example.test";
/** A 32-byte secret in base64url: how the keyring password is made. */
const KEYRING = /^[\w-]{43}$/;

beforeEach(() => {
  delete process.env.GOG_KEYRING_PASSWORD;
  delete process.env.GOG_CLIENT;
  rmSync(SECRETS.gogKeyring, { force: true });
});
afterEach(() => {
  rmSync(SECRETS.gogKeyring, { force: true });
});

/** What a call did: which `auth` verb, `credentials`' own for a pair. */
const did = (cmd: string[]) => (cmd[2] === "credentials" ? cmd[3] : cmd[2]);

/** A made-up gog holding the clients named: its `credentials list` answers them, everything else succeeds. */
function gog(clients: string[] = []) {
  const calls: string[][] = [];
  const run = (cmd: string[]) => {
    calls.push(cmd);
    const ok = (stdout: string) =>
      Promise.resolve({ code: 0, stderr: "", stdout });
    return did(cmd) === "list"
      ? ok(JSON.stringify({ clients: clients.map((client) => ({ client })) }))
      : ok("{}");
  };
  return { calls, run };
}

/** A file that looks like the Desktop OAuth client `scripts/app.ts` copies in. */
function clientFile() {
  const file = join(mkdtempSync(join(tmpdir(), "google-client-")), "c.json");
  writeFileSync(
    file,
    JSON.stringify({
      installed: {
        client_id: "123-made-up.apps.googleusercontent.com",
        client_secret: "made-up",
      },
    })
  );
  return file;
}

test("the client this build carries goes into gog's own bucket, then his sign-in asks for what Life reads", async () => {
  const g = gog();
  await connectGoogle(ANA, { clientFile: clientFile(), run: g.run });
  expect(g.calls[0]).toEqual([
    "gog",
    "auth",
    "credentials",
    "list",
    "--json",
    "--no-input",
  ]);
  expect(g.calls[1]?.slice(0, 5)).toEqual([
    "gog",
    "auth",
    "credentials",
    "set",
    expect.stringContaining("c.json"),
  ]);
  expect(g.calls[1]).toContain("--client=life");
  expect(g.calls[2]).toEqual([
    "gog",
    "auth",
    "add",
    ANA,
    "--services=gmail,calendar,tasks",
    "--gmail-scope=read-send",
    "--extra-scopes=https://www.googleapis.com/auth/contacts.readonly",
    "--force-consent",
    "--timeout=5m",
    "--json",
  ]);
  // The keyring's password is made here, once: gog reads the same one at every later call.
  expect(gogKeyringPassword()).toMatch(KEYRING);
});

test("a client gog already holds under Life's name, or his own name, stays as it is", async () => {
  const kept = gog(["life"]);
  await connectGoogle(ANA, {
    clientFile: "/nowhere/client.json",
    run: kept.run,
  });
  expect(kept.calls.map(did)).toEqual(["list", "add"]);

  const own = gog(["his-own"]);
  process.env.GOG_CLIENT = "his-own";
  await connectGoogle(ANA, { run: own.run });
  expect(own.calls.map(did)).toEqual(["list", "add"]);
});

test("a build with no Google client says so in one sentence, and nothing is signed in", async () => {
  const g = gog();
  await expect(
    connectGoogle(ANA, { clientFile: "/nowhere/client.json", run: g.run })
  ).rejects.toThrow(
    "This build has no Google client: store your own with `gog auth credentials set <file> --client life`, then run this again."
  );
  expect(g.calls.map(did)).toEqual(["list"]);
});

test("an address that isn't one is refused before gog runs", async () => {
  const g = gog();
  await expect(connectGoogle("not-an-address", { run: g.run })).rejects.toThrow(
    `"not-an-address" isn't a mail address.`
  );
  expect(g.calls).toEqual([]);
  expect(gogKeyringPassword()).toBeUndefined();
});
