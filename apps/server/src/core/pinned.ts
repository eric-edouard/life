import { createWriteStream, existsSync, lstatSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { MIN } from "./clock";
import { sha256Of } from "./hash";
import { execOk } from "./proc";

// What Life downloads from the internet at a fixed version, checked against its sha256 before it is used: the build
// scripts' tools and the describer's model files.

export interface Pin {
  sha256: string;
  url: string;
}

/** llama.cpp's server, from its release, which Lifelog Host (the embedder) and Life.app (the describer) bundle. */
export const llamaRelease = (arch: "amd64" | "arm64"): Pin => ({
  sha256:
    arch === "arm64"
      ? "4f5b8de12e0b9516658ca6a5764c6ffb3d7c659c3dd538556b1413c7b4050662"
      : "c8094268b6bf62f4998f0e45656fd9f5e2d4afb6b1cd0044d761db64be1dd47d",
  url: `https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-macos-${arch === "arm64" ? "arm64" : "x64"}.tar.gz`,
});

/** What the bundles keep of the release: the server and the libraries it loads from beside it (@loader_path). */
const LLAMA_LOADED = [
  "llama-server",
  "LICENSE",
  "libllama-server-impl.dylib",
  "libllama-common*",
  "libmtmd*",
  "libllama.*",
  "libggml*",
];

/**
 * llama.cpp's server for this Mac's architecture in `dest`, with the libraries it loads from beside it, each signed
 * by `sign` (the release links its versioned libraries by name: the files are signed, not the links). The release is
 * downloaded into `cache`.
 */
export async function bundleLlama(
  dest: string,
  cache: string,
  sign: (file: string) => Promise<unknown>
) {
  const pin = llamaRelease(process.arch === "arm64" ? "arm64" : "amd64");
  await mkdir(dest, { recursive: true });
  await execOk([
    ...["tar", "-xzf", await download(pin, join(cache, basename(pin.url)))],
    ...["-C", dest, "--strip-components", "1"],
    ...LLAMA_LOADED.flatMap((f) => ["--include", `*/${f}`]),
  ]);
  const libraries = [...new Bun.Glob("*.dylib").scanSync(dest)].filter(
    (f) => !lstatSync(join(dest, f)).isSymbolicLink()
  );
  for (const file of [...libraries, "llama-server"]) {
    // biome-ignore lint/performance/noAwaitInLoops: signing order matters
    await sign(join(dest, file));
  }
}

/** A download that gives no bytes for this long is cut and tried again from where it stopped. */
const STALL = 2 * MIN;
const ATTEMPTS = 3;

/** One try: the bytes from where `part` stops, appended to it. */
async function fetchPart(pin: Pin, part: string) {
  const have = existsSync(part) ? statSync(part).size : 0;
  const cut = new AbortController();
  let timer: Timer | undefined;
  const alive = () => {
    clearTimeout(timer);
    timer = setTimeout(() => cut.abort(), STALL);
  };
  alive();
  try {
    const res = await fetch(pin.url, {
      headers: have ? { range: `bytes=${have}-` } : {},
      signal: cut.signal,
    });
    // 416: the part already holds the whole file.
    if (res.status === 416) {
      return;
    }
    if (!(res.ok && res.body)) {
      throw new Error(`${pin.url}: ${res.status}`);
    }
    await pipeline(
      Readable.from(res.body),
      async function* (chunks: AsyncIterable<Uint8Array>) {
        for await (const chunk of chunks) {
          alive();
          yield chunk;
        }
      },
      createWriteStream(part, { flags: res.status === 206 ? "a" : "w" })
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * `pin` as `file`, downloaded once. The bytes go to `file.part` (a cut or stalled download resumes from there, up to
 * three tries), and `file` exists only once they match the pin's sha256, so an existing file is trusted. Streamed: a
 * multi-gigabyte model is never in memory.
 */
export async function download(pin: Pin, file: string) {
  if (existsSync(file)) {
    return file;
  }
  await mkdir(dirname(file), { recursive: true });
  const part = `${file}.part`;
  for (let attempt = 1; ; attempt += 1) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: each try resumes the last
      await fetchPart(pin, part);
      break;
    } catch (e) {
      if (attempt === ATTEMPTS) {
        throw e;
      }
    }
  }
  const sum = await sha256Of(part);
  if (sum !== pin.sha256) {
    await rm(part);
    throw new Error(`${pin.url} does not match its pinned sha256 (${sum})`);
  }
  await rename(part, file);
  return file;
}
