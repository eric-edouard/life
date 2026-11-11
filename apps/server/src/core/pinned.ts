import { createWriteStream, existsSync, statSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { sha256Of } from "./hash";

// What Life downloads from the internet at a fixed version, checked against its sha256 before it is used: the build
// scripts' tools and the describer's model files.

export interface Pin {
  sha256: string;
  url: string;
}

/** llama.cpp's server, from its release, which Lifelog Host (the embedder) and Life.app (the describer) bundle. */
export const llamaRelease = (arch: "amd64" | "arm64") => ({
  amd64: "c8094268b6bf62f4998f0e45656fd9f5e2d4afb6b1cd0044d761db64be1dd47d",
  arm64: "4f5b8de12e0b9516658ca6a5764c6ffb3d7c659c3dd538556b1413c7b4050662",
  url: `https://github.com/ggml-org/llama.cpp/releases/download/b12110/llama-b12110-bin-macos-${arch === "arm64" ? "arm64" : "x64"}.tar.gz`,
});

/**
 * `pin` as `file`, downloaded once. The bytes go to `file.part` (a cut download resumes from there), and `file` exists
 * only once they match the pin's sha256, so an existing file is trusted. Streamed: a multi-gigabyte model is never in memory.
 */
export async function download(pin: Pin, file: string) {
  if (existsSync(file)) {
    return file;
  }
  await mkdir(dirname(file), { recursive: true });
  const part = `${file}.part`;
  const have = existsSync(part) ? statSync(part).size : 0;
  const res = await fetch(pin.url, {
    headers: have ? { range: `bytes=${have}-` } : {},
  });
  // 416: the part already holds the whole file.
  if (res.status !== 416) {
    if (!(res.ok && res.body)) {
      throw new Error(`${pin.url}: ${res.status}`);
    }
    await pipeline(
      Readable.from(res.body),
      createWriteStream(part, { flags: res.status === 206 ? "a" : "w" })
    );
  }
  const sum = await sha256Of(part);
  if (sum !== pin.sha256) {
    await rm(part);
    throw new Error(`${pin.url} does not match its pinned sha256 (${sum})`);
  }
  await rename(part, file);
  return file;
}
