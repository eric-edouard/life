// Opens the installed Host's voice map. Rotating its scoped hash restarts only the supervised
// server child: Host already rereads server.env and restarts a stopped child (README, How it works).
import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execOk } from "@life/server/src/core/proc";
import { mintToken } from "./mint-token";

const PROCESS = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/;
const LOOPBACK = /^n127\.0\.0\.1:\d+$/;

export function parseHostServer(table: string) {
  const processes = table.split("\n").flatMap((line) => {
    const match = PROCESS.exec(line);
    return match
      ? [
          {
            parent: Number(match[2]),
            path: match[3] ?? "",
            pid: Number(match[1]),
          },
        ]
      : [];
  });
  const servers = processes.filter((p) => {
    const suffix = "/Contents/Helpers/lifelog-server";
    if (!p.path.endsWith(suffix)) {
      return false;
    }
    const host = `${p.path.slice(0, -suffix.length)}/Contents/MacOS/LifelogHost`;
    return processes.some(
      (parent) => parent.pid === p.parent && parent.path === host
    );
  });
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
  const temporary = `${file}.${randomUUID()}`;
  try {
    await writeFile(temporary, mapEnvironment(source, hash), {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, file);
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
  pause = () => Bun.sleep(500),
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
  // Refuse an old installed build before rotating a key or stopping anything.
  const page = await request(`${base}/voices`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!(page.ok && page.headers.get("Content-Type")?.startsWith("text/html"))) {
    throw new Error(
      "The installed Host has no voice map yet. Build and install this version first."
    );
  }
  const { hash, token } = mintToken("map");
  await update(file, hash);
  stop(server.pid);
  for (let attempt = 0; attempt < 40; attempt += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: Host's existing supervised restart, bounded readiness
    await pause();
    const response = await request(`${base}/speakers/map`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(1000),
    }).catch(() => null);
    if (response?.ok) {
      await response.body?.cancel();
      const link = new URL("/voices", base);
      link.hash = new URLSearchParams({ token }).toString();
      // stdin keeps the bearer out of ps, shell history and terminal output.
      await run(["osascript", "-"], {
        stdin: `open location ${JSON.stringify(link.toString())}\n`,
      });
      return;
    }
    await response?.body?.cancel();
  }
  throw new Error(
    "The map token was rotated, but Host did not accept it after restarting. Check Lifelog Host's server status and installed version."
  );
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
