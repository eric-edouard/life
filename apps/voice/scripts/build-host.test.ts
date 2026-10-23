import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "../src/config";
import { buildHost } from "./build-host";

const TOKEN = "host-test-token";

test("the host binary runs alone: it migrates a new archive, answers and labels pages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-host-"));
  try {
    const binary = await buildHost(dir);
    const port = 40_000 + Math.floor(Math.random() * 10_000);
    const server = Bun.spawn([binary], {
      env: {
        AUDIO_DIR: join(dir, "audio"),
        DATABASE_PATH: join(dir, "archive.sqlite"),
        DEVICE_TOKEN_HASH: sha256Hex(TOKEN),
        ELEVENLABS_API_KEY: "test",
        PORT: String(port),
        PUBLIC_BASE_URL: "https://mac.example.test",
      },
      stderr: "inherit",
      stdout: "ignore",
    });
    try {
      let ok = false;
      for (let tries = 0; tries < 50 && !ok; tries += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: wait for it to listen
        await Bun.sleep(100);
        ok = await fetch(`http://localhost:${port}/health`)
          .then((r) => r.ok)
          .catch(() => false);
      }
      expect(ok).toBe(true);
      // It labels an Omi's pages itself: Opus and Silero run in its worker, from inside it.
      const records = await Bun.file(
        join(import.meta.dir, "../../../fixtures/pages/omi.bin")
      ).bytes();
      const form = new FormData();
      form.append("pages", new File([records], "pages.bin"));
      form.append(
        "metadata",
        JSON.stringify({
          codec: "omi",
          pages: Array.from({ length: records.length / 444 }, (_, index) => ({
            index,
            length: 444,
          })),
          sha256: sha256Hex(records),
        })
      );
      const auth = { Authorization: `Bearer ${TOKEN}` };
      const put = await fetch(
        `http://localhost:${port}/sources/omi-pendant/pages/0`,
        { body: form, headers: auth, method: "PUT" }
      );
      expect(put.status).toBe(200);
      let labeled: string | null = null;
      for (let tries = 0; tries < 100 && !labeled; tries += 1) {
        // biome-ignore lint/performance/noAwaitInLoops: wait for the pass
        await Bun.sleep(100);
        const state = await fetch(
          `http://localhost:${port}/sources/omi-pendant/ingest`,
          { headers: auth }
        ).then((r) => r.json());
        labeled = state.labeledUntil;
      }
      expect(labeled).toBe("2026-10-12T10:01:13.480Z");
      // Its export runs beside it, and goes back into a new install.
      const run = (args: string[], at: string) =>
        Bun.spawnSync([binary, ...args], {
          env: {
            AUDIO_DIR: join(dir, at, "audio"),
            DATABASE_PATH: join(dir, at, "archive.sqlite"),
          },
        });
      const exported = run(["export", join(dir, "export")], "");
      expect(JSON.parse(exported.stdout.toString())).toMatchObject({
        ok: true,
      });
      const imported = run(["import", join(dir, "export")], "copy");
      // The archive, the pages and the speech fragment cut from them.
      expect(JSON.parse(imported.stdout.toString())).toMatchObject({
        files: 3,
        ok: true,
      });
    } finally {
      server.kill();
      await server.exited;
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}, 60_000);

test("the host binary compiles for Windows, its VAD worker and runtime inside", async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-host-windows-"));
  try {
    const binary = await buildHost(dir, "bun-windows-x64");
    const bytes = await Bun.file(binary).bytes();
    // A PE executable, with the worker and the runtime's files embedded by name.
    expect(String.fromCharCode(bytes[0] ?? 0, bytes[1] ?? 0)).toBe("MZ");
    const text = new TextDecoder("latin1").decode(bytes);
    for (const name of [
      "vad-worker",
      "ort-wasm-simd-threaded.wasm",
      "silero-vad-v6.0-16k",
    ]) {
      expect(text.includes(name)).toBe(true);
    }
    expect(await Bun.file(join(dir, "NOTICE")).exists()).toBe(true);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}, 120_000);
