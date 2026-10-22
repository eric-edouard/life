import { createHash } from "node:crypto";

/** The first `n` hex of a hash of `s`: how ids and content hashes are made. */
export const digest = (algo: string, s: string | Buffer, n: number) =>
  createHash(algo).update(s).digest("hex").slice(0, n);
