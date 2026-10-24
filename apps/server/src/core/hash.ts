import { createHash } from "node:crypto";

/** The first `n` hex of a hash of `s`: how ids and content hashes are made. */
export const digest = (algo: string, s: string | Buffer, n: number) =>
  createHash(algo).update(s).digest("hex").slice(0, n);

/** A file's sha256, read as a stream. */
export async function sha256Of(path: string) {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) {
    hasher.update(chunk);
  }
  return hasher.digest("hex");
}
