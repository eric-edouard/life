// Opens the installed Host's voice map, reusing its scoped token from the macOS Keychain.
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { exec, execOk, untilAnswers } from "@life/server/src/core/proc";
import { sha256Hex } from "../src/config";
import { mintToken } from "./mint-token";

const PROCESS = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/gm;
const LOOPBACK = /^n127\.0\.0\.1:\d+$/;

export function parseHostServer(table: string) {
  const processes = [...table.matchAll(PROCESS)].map(
    ([, pid, parent, path]) => ({
      parent: Number(parent),
      path: path ?? "",
      pid: Number(pid),
    })
  );
  const suffix = "/Contents/Helpers/lifelog-server";
  const servers = processes.filter(
    (p) =>
      p.path.endsWith(suffix) &&
      processes.some(
        (parent) =>
          parent.pid === p.parent &&
          parent.path ===
            `${p.path.slice(0, -suffix.length)}/Contents/MacOS/LifelogHost`
      )
  );
  if (servers.length !== 1 || !servers[0]) {
    throw new Error(
      "Expected one running server managed by Lifelog Host; no token or process changed."
    );
  }
  return servers[0];
}

// Match whole assignments, including multiline quotes, as Host.environmentFile does. A string
// inside another key's quoted value must never be mistaken for the map key.
export function mapEnvironment(source: string, hash: string) {
  const assignments =
    /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(?:'[^']*'|"[^"]*"|[^\n]*)$/gm;
  return `${source.replace(assignments, (whole, key) => (key === "MAP_TOKEN_HASH" ? "" : whole)).trimEnd()}\nMAP_TOKEN_HASH='${hash}'\n`;
}

export async function readMapToken(run = exec) {
  const find = () =>
    run(["security", "find-generic-password", "-s", "lifelog-map-token", "-w"]);
  const found = await find();
  if (found.code === 0 && found.stdout.trim()) {
    return found.stdout.trim();
  }
  if (found.code !== 44) {
    throw new Error(
      "Cannot read the voice map token from Keychain; nothing changed."
    );
  }
  const { token } = mintToken("map");
  // Interactive security reads commands from stdin, keeping the bearer out of process arguments.
  await run(["security", "-i"], {
    stdin: `add-generic-password -a lifelog -s lifelog-map-token -w ${token}\n`,
  });
  const saved = await find();
  if (saved.code !== 0 || saved.stdout.trim() !== token) {
    throw new Error(
      "Cannot save the voice map token in Keychain; server unchanged."
    );
  }
  return token;
}

async function activate(file: string, hash: string) {
  const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  });
  if (stat && (!stat.isFile() || stat.mode % 0o100 !== 0)) {
    throw new Error(
      "server.env must be an owner-only regular file; nothing changed."
    );
  }
  const source = stat ? await readFile(file, "utf8") : "";
  if (parseEnv(source).MAP_TOKEN_HASH === hash) {
    return false;
  }
  const temporary = `${file}.${randomUUID()}`;
  try {
    await writeFile(temporary, mapEnvironment(source, hash), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
    return true;
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function openVoices({
  file = join(homedir(), "Library/Application Support/lifelog/server.env"),
  run = execOk,
  update = activate,
  stop = (pid: number) => {
    process.kill(pid, "SIGTERM");
  },
  request = (url: string, options?: RequestInit) => fetch(url, options),
  readToken = readMapToken,
} = {}) {
  const server = parseHostServer(await run(["ps", "-axo", "pid=,ppid=,comm="]));
  const sockets = await run([
    "lsof",
    "-nP",
    "-a",
    "-p",
    String(server.pid),
    "-iTCP",
    "-sTCP:LISTEN",
    "-Fn",
  ]);
  const addresses = sockets.split("\n").filter((line) => line.startsWith("n"));
  const [address] = addresses;
  if (addresses.length !== 1 || !address || !LOOPBACK.test(address)) {
    throw new Error(
      "The Host server must listen on one loopback address; nothing changed."
    );
  }
  const base = `http://${address.slice(1)}`;
  // Refuse an old installed build before activating a key or stopping anything.
  const page = await request(`${base}/voices`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!(page.ok && page.headers.get("Content-Type")?.startsWith("text/html"))) {
    throw new Error(
      "The installed Host has no voice map yet. Build and install this version first."
    );
  }
  const token = await readToken();
  if (await update(file, sha256Hex(token))) {
    stop(server.pid);
    await untilAnswers(async () => {
      const response = await request(
        `${base}/transcripts/00000000-0000-0000-0000-000000000000/audio`,
        {
          headers: { Authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(1000),
        }
      );
      await response.body?.cancel();
      // Auth runs before routing: nil UUID has no audio, so 404 proves this token passed auth.
      return response.status === 404 ? true : undefined;
    }, "Host accepting the map token after restarting");
  }
  const link = new URL("/voices", base);
  link.hash = new URLSearchParams({ token }).toString();
  await run(["osascript", "-"], {
    stdin: `open location ${JSON.stringify(link.toString())}\n`,
  });
}

if (import.meta.main) {
  if (process.platform !== "darwin") {
    throw new Error("bun run voices opens Lifelog Host on the Mac.");
  }
  await openVoices();
  console.log(
    "Opened the voice map. The link's token opens only its data, clips and naming answers."
  );
}
