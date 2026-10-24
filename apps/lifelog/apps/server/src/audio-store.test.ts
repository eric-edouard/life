import { expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { audioStore, blockKey, diskAudioStore } from "./audio-store";
import { testConfig } from "./testing";

test("the disk keeps each key once, whole, and refuses a key that climbs out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "audio-"));
  try {
    const store = diskAudioStore(dir);
    const key = blockKey("dev1", 7, "abc");
    expect(await store.get(key)).toBeNull();
    await store.put(key, new Uint8Array([1, 2]));
    // Stored once: a second put of the same key changes nothing.
    await store.put(key, new Uint8Array([9]));
    expect(await store.get(key)).toEqual(new Uint8Array([1, 2]));
    expect(await readdir(join(dir, "blocks/dev1"))).toEqual(["7-abc.ogg"]);
    await store.delete(key);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await expect(store.get(blockKey("..", 7, "abc"))).rejects.toThrow();
    await expect(store.get("blocks\\..\\..\\x.ogg")).rejects.toThrow();
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("the bucket when set, the disk without it, and never half a bucket or neither", () => {
  const config = (env: Record<string, string>) =>
    testConfig("http://localhost:1", env);
  expect(() => audioStore(config({ AUDIO_DIR: "/tmp/audio" }))).not.toThrow();
  const bucket = {
    S3_ACCESS_KEY_ID: "k",
    S3_BUCKET: "b",
    S3_ENDPOINT: "http://localhost:1",
    S3_REGION: "r",
    S3_SECRET_ACCESS_KEY: "s",
  };
  expect(() => audioStore(config(bucket))).not.toThrow();
  expect(() => audioStore(config({}))).toThrow();
  expect(() =>
    audioStore(config({ AUDIO_DIR: "/tmp/audio", S3_BUCKET: "b" }))
  ).toThrow();
});
