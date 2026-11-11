import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "./hash";
import { download, llamaRelease } from "./pinned";

const FROM = /bytes=(\d+)-/;
const body = Buffer.from("made-up model bytes ".repeat(1000));
const sha256 = digest("sha256", body, 64);
let server: ReturnType<typeof Bun.serve>;
const dir = mkdtempSync(join(tmpdir(), "life-pinned-"));

beforeAll(() => {
  server = Bun.serve({
    fetch(req) {
      const from = Number(FROM.exec(req.headers.get("range") ?? "")?.[1]);
      if (Number.isNaN(from)) {
        return new Response(body);
      }
      return from >= body.length
        ? new Response(null, { status: 416 })
        : new Response(body.subarray(from), { status: 206 });
    },
    port: 0,
  });
});
afterAll(() => server.stop(true));

const pin = (hash = sha256) => ({
  sha256: hash,
  url: `${server.url}model.gguf`,
});

test("downloads a file once, checked against its sha256", async () => {
  const file = join(dir, "whole.gguf");
  await download(pin(), file);
  expect(readFileSync(file)).toEqual(body);
  // An existing file is trusted: no request is made for it.
  expect(
    await download({ ...pin(), url: "http://127.0.0.1:1/gone" }, file)
  ).toBe(file);
});

test("resumes a cut download, and a whole part", async () => {
  const cut = join(dir, "cut.gguf");
  writeFileSync(`${cut}.part`, body.subarray(0, 5000));
  await download(pin(), cut);
  expect(readFileSync(cut)).toEqual(body);
  const whole = join(dir, "whole-part.gguf");
  writeFileSync(`${whole}.part`, body);
  await download(pin(), whole);
  expect(readFileSync(whole)).toEqual(body);
});

test("refuses bytes that do not match, and leaves no file", async () => {
  const file = join(dir, "bad.gguf");
  await expect(download(pin("0".repeat(64)), file)).rejects.toThrow(
    "does not match"
  );
  expect(Bun.file(file).size).toBe(0);
  expect(Bun.file(`${file}.part`).size).toBe(0);
});

test("llama.cpp's release is named for the architecture", () => {
  expect(llamaRelease("arm64").url).toContain("macos-arm64.tar.gz");
  expect(llamaRelease("amd64").url).toContain("macos-x64.tar.gz");
});
