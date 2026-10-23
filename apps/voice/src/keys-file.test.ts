import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// On a server the keys come from Life's keys file (KEYS_FILE, index.ts): without the ones it needs the server waits
// for them instead of starting again and again, and a change to the file ends it so Docker starts it with the keys.
test("a server without its keys waits for them, and a change to the keys file ends it", async () => {
  const keys = join(mkdtempSync(join(tmpdir(), "voice-keys-")), "secrets.env");
  writeFileSync(keys, "OTHER_KEY=x\n");
  const server = Bun.spawn(["bun", join(import.meta.dir, "index.ts")], {
    env: { KEYS_FILE: keys, PATH: process.env.PATH },
    stdout: "pipe",
  });
  const reader = server.stdout.getReader();
  const { value } = await reader.read();
  expect(new TextDecoder().decode(value)).toContain(
    `waiting for its keys in ${keys}: `
  );
  writeFileSync(keys, "OTHER_KEY=x\nDEVICE_TOKEN_HASH=y\n");
  expect(await server.exited).toBe(0);
}, 15_000);
