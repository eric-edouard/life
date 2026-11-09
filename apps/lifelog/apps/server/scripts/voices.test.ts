import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/config";
import { mapEnvironment, openVoices, parseHostServer } from "./voices";

const table = `100 1 /Applications/Lifelog Host.app/Contents/MacOS/LifelogHost
101 100 /Applications/Lifelog Host.app/Contents/Helpers/lifelog-server`;

test("launcher identifies only a Host-managed child, never a separate archive writer", () => {
  expect(parseHostServer(table).pid).toBe(101);
  expect(() => parseHostServer(table.replace("101 100", "101 999"))).toThrow();
  expect(() =>
    parseHostServer(
      `${table}\n102 100 /Applications/Lifelog Host.app/Contents/Helpers/lifelog-server`
    )
  ).toThrow();
});

test("hash rotation preserves unrelated multiline settings and replaces exported/duplicate map keys", () => {
  const source = `# settings\nSECRET='first\nMAP_TOKEN_HASH=inside a value\nlast'\nexport MAP_TOKEN_HASH=old\nOTHER="more\nwords"\nMAP_TOKEN_HASH='duplicate'\n`;
  const updated = mapEnvironment(source, "a".repeat(64));
  expect(updated).toContain(
    "SECRET='first\nMAP_TOKEN_HASH=inside a value\nlast'"
  );
  expect(updated).toContain('OTHER="more\nwords"');
  expect(updated).not.toContain("old");
  expect(updated).not.toContain("duplicate");
  expect(updated).toEndWith(`MAP_TOKEN_HASH='${"a".repeat(64)}'\n`);
});

test("launcher activates only a map token, waits for it, opens fragment through stdin and writes an owner-only env", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voices-launch-"));
  const file = join(dir, "server.env");
  let stopped = false;
  let authorization = "";
  let opened = "";
  let attempts = 0;
  try {
    await openVoices({
      file,
      pause: () => Promise.resolve(),
      request: (url: string, options?: RequestInit) => {
        if (String(url).endsWith("/voices")) {
          return Promise.resolve(
            new Response("shell", { headers: { "Content-Type": "text/html" } })
          );
        }
        expect(stopped).toBe(true);
        attempts += 1;
        authorization =
          new Headers(options?.headers).get("Authorization") ?? "";
        return Promise.resolve(
          new Response("{}", { status: attempts === 1 ? 401 : 200 })
        );
      },
      run: (cmd, options) => {
        if (cmd[0] === "ps") {
          return Promise.resolve(table);
        }
        if (cmd[0] === "lsof") {
          expect(cmd).toContain("-nP");
          return Promise.resolve("p101\nn127.0.0.1:45678\n");
        }
        expect(cmd).toEqual(["osascript", "-"]);
        opened = options?.stdin ?? "";
        return Promise.resolve("");
      },
      stop: (pid) => {
        expect(pid).toBe(101);
        stopped = true;
      },
    });
    const token = authorization.replace("Bearer ", "");
    expect(await readFile(file, "utf8")).toContain(sha256Hex(token));
    expect((await stat(file)).mode % 0o1000).toBe(0o600);
    expect(opened).toContain(`/voices#token=${token}`);
    expect(opened).not.toContain("?token=");
    expect(attempts).toBe(2);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("unsafe listener or old build leaves the token and process unchanged; readiness failure never opens", async () => {
  let changed = false;
  let stopped = false;
  let opened = false;
  const options = {
    pause: () => Promise.resolve(),
    request: () => Promise.resolve(new Response(null, { status: 404 })),
    run: (cmd: string[]) => {
      if (cmd[0] === "ps") {
        return Promise.resolve(table);
      }
      if (cmd[0] === "lsof") {
        return Promise.resolve("n*:45678");
      }
      opened = true;
      return Promise.resolve("");
    },
    stop: () => {
      stopped = true;
    },
    update: () => {
      changed = true;
      return Promise.resolve();
    },
  };
  await expect(openVoices(options)).rejects.toThrow("loopback");
  expect(changed || stopped || opened).toBe(false);
  const run = (cmd: string[]) =>
    cmd[0] === "lsof" ? Promise.resolve("n127.0.0.1:45678") : options.run(cmd);
  await expect(openVoices({ ...options, run })).rejects.toThrow("no voice map");
  expect(changed || stopped || opened).toBe(false);
  const request = (url: string) =>
    Promise.resolve(
      String(url).endsWith("/voices")
        ? new Response("", { headers: { "Content-Type": "text/html" } })
        : new Response(null, { status: 401 })
    );
  await expect(openVoices({ ...options, request, run })).rejects.toThrow(
    "did not accept"
  );
  expect(changed && stopped).toBe(true);
  expect(opened).toBe(false);
});
