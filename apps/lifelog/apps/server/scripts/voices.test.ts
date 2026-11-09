import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/config";
import {
  mapEnvironment,
  openVoices,
  parseHostServer,
  readMapToken,
} from "./voices";

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
    const launch = {
      file,
      readToken: () => Promise.resolve("test-map-bearer"),
      request: (url: string, options?: RequestInit) => {
        if (String(url).endsWith("/voices")) {
          return Promise.resolve(
            new Response("shell", { headers: { "Content-Type": "text/html" } })
          );
        }
        expect(stopped).toBe(true);
        expect(url).toEndWith(
          "/transcripts/00000000-0000-0000-0000-000000000000/audio"
        );
        expect(options?.method ?? "GET").toBe("GET");
        attempts += 1;
        authorization =
          new Headers(options?.headers).get("Authorization") ?? "";
        return Promise.resolve(
          new Response("{}", { status: [401, 200, 404][attempts - 1] ?? 404 })
        );
      },
      run: (cmd: string[], options?: { stdin?: string }) => {
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
      stop: (pid: number) => {
        expect(pid).toBe(101);
        stopped = true;
      },
    };
    await openVoices(launch);
    const token = authorization.replace("Bearer ", "");
    expect(await readFile(file, "utf8")).toContain(sha256Hex(token));
    expect((await stat(file)).mode % 0o1000).toBe(0o600);
    expect(opened).toContain(`/voices#token=${token}`);
    expect(opened).not.toContain("?token=");
    expect(attempts).toBe(3);
    stopped = false;
    const before = (await stat(file)).mtimeMs;
    await openVoices(launch);
    expect(stopped).toBe(false);
    expect(attempts).toBe(3);
    expect((await stat(file)).mtimeMs).toBe(before);
    // Losing the hash activates the same Keychain token once more.
    await Bun.write(file, "OTHER=value\n");
    await openVoices(launch);
    expect(stopped).toBe(true);
    expect(await readFile(file, "utf8")).toContain(sha256Hex(token));
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("unsafe listener or old build leaves the token and process unchanged; readiness failure never opens", async () => {
  let changed = false;
  let stopped = false;
  let opened = false;
  const options = {
    readToken: () => Promise.resolve("test-map-bearer"),
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
      return Promise.resolve(true);
    },
  };
  await expect(openVoices(options)).rejects.toThrow("loopback");
  expect(changed || stopped || opened).toBe(false);
  const run = (cmd: string[]) =>
    cmd[0] === "lsof" ? Promise.resolve("n127.0.0.1:45678") : options.run(cmd);
  await expect(openVoices({ ...options, run })).rejects.toThrow("no voice map");
  expect(changed || stopped || opened).toBe(false);
  expect(changed || stopped || opened).toBe(false);
});

test("Keychain mints once, keeps the bearer out of argv, and fails closed on read/write errors", async () => {
  let stored = "";
  let writes = 0;
  const run: Parameters<typeof readMapToken>[0] = (cmd, options) => {
    const result = { code: 0, killed: null, stderr: "", stdout: "" };
    if (cmd[1] === "find-generic-password") {
      return Promise.resolve({
        ...result,
        code: stored ? 0 : 44,
        stdout: stored,
      });
    }
    expect(cmd).toEqual(["security", "-i"]);
    stored = options?.stdin?.trim().split(" ").at(-1) ?? "";
    writes += 1;
    return Promise.resolve(result);
  };
  const token = await readMapToken(run);
  expect(token).toHaveLength(43);
  expect(await readMapToken(run)).toBe(token);
  expect(writes).toBe(1);
  await expect(
    readMapToken(() =>
      Promise.resolve({ code: 1, killed: null, stderr: "locked", stdout: "" })
    )
  ).rejects.toThrow("Cannot read");
  await expect(
    readMapToken(() =>
      Promise.resolve({ code: 44, killed: null, stderr: "", stdout: "" })
    )
  ).rejects.toThrow("Cannot save");
});
