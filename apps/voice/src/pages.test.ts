import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rawPages } from "@life/voice-db/schema";
import { createApp } from "./app";
import { diskAudioStore, memoryAudioStore, pagesKey } from "./audio-store";
import { sha256Hex } from "./config";
import { services } from "./services";
import { OWNER_TOKEN, testConfig, testDb } from "./testing";

let env: ReturnType<typeof testDb>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});

const SOURCE = "omi-pendant";
const READ = "read-test-token";
const appWith = () => {
  const audio = memoryAudioStore();
  const s = services(
    testConfig("http://localhost:1", { READ_TOKEN_HASH: sha256Hex(READ) }),
    env.db,
    { audio, intelligence: null, search: null }
  );
  return Object.assign(createApp(s), { audio });
};

// A page's bytes: `length` bytes of `fill`.
const page = (fill: number, length = 444) => new Uint8Array(length).fill(fill);

function batch(first: number, pages: Uint8Array[]) {
  const bytes = new Uint8Array(Buffer.concat(pages));
  const metadata = {
    codec: "omi",
    pages: pages.map((p, i) => ({ index: first + i, length: p.length })),
    sha256: sha256Hex(bytes),
  };
  return { bytes, metadata };
}

async function put(
  app: ReturnType<typeof appWith>,
  first: number,
  { bytes, metadata }: ReturnType<typeof batch>,
  token = OWNER_TOKEN,
  source = SOURCE
) {
  const form = new FormData();
  form.append("pages", new File([bytes], "pages.bin"));
  form.append("metadata", JSON.stringify(metadata));
  const res = await app.request(`/sources/${source}/pages/${first}`, {
    body: form,
    headers: { Authorization: `Bearer ${token}` },
    method: "PUT",
  });
  const text = await res.text();
  return {
    body: text.startsWith("{") ? JSON.parse(text) : text,
    status: res.status,
  };
}

const rows = () => env.db.select().from(rawPages).all();

test("pages are stored once, byte for byte, and a resend is accepted without a copy", async () => {
  const app = appWith();
  const sent = batch(0, [page(1), page(2, 100), page(3)]);
  expect(await put(app, 0, sent)).toEqual({
    body: { highestPage: 2, labeledUntil: null },
    status: 200,
  });
  const key = pagesKey(SOURCE, 0, sent.metadata.sha256);
  expect(app.audio.objects.get(key)).toEqual(sent.bytes);
  const stored = rows().find((r) => r.pageIndex === 1);
  expect(stored).toMatchObject({ length: 100, offset: 444 });
  expect(app.audio.objects.get(key)?.subarray(stored?.offset, 544)).toEqual(
    page(2, 100)
  );

  // The same batch again, and one overlapping it: nothing written twice.
  expect((await put(app, 0, sent)).body).toEqual({
    highestPage: 2,
    labeledUntil: null,
  });
  const after = await put(app, 2, batch(2, [page(3), page(4)]));
  expect(after.body).toEqual({ highestPage: 3, labeledUntil: null });
  expect(app.audio.writes).toBe(2);
  expect(rows().map((r) => r.pageIndex)).toEqual([0, 1, 2, 3]);
  const res = await app.request(`/sources/${SOURCE}/ingest`, {
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
  });
  expect(await res.json()).toEqual({ highestPage: 3, labeledUntil: null });
});

test("a new flash life's band, past a hole, is kept", async () => {
  const app = appWith();
  const index = 2 ** 40 + 7;
  expect((await put(app, index, batch(index, [page(9)]))).body).toEqual({
    highestPage: index,
    labeledUntil: null,
  });
});

test("other bytes at a stored index are refused, and nothing of the batch is kept", async () => {
  const app = appWith();
  await put(app, 0, batch(0, [page(1), page(2)]));
  const clash = batch(1, [page(7), page(8)]);
  const res = await put(app, 1, clash);
  expect(res.status).toBe(409);
  expect(res.body.error).toBe("page_conflict");
  expect(res.body.page).toBe(1);
  expect(rows().map((r) => r.pageIndex)).toEqual([0, 1]);
  expect(
    app.audio.objects.has(pagesKey(SOURCE, 1, clash.metadata.sha256))
  ).toBe(false);
});

test("a conflict names the first index that holds other bytes, not the batch's first", async () => {
  const app = appWith();
  await put(app, 0, batch(0, [page(1), page(2)]));
  const res = await put(app, 0, batch(0, [page(1), page(9)]));
  expect(res.status).toBe(409);
  expect(res.body.page).toBe(1);
  expect(rows().map((r) => r.pageIndex)).toEqual([0, 1]);
});

test("a bad hash, lengths that don't add up, or a batch not contiguous from firstPage are refused", async () => {
  const app = appWith();
  const good = batch(5, [page(1), page(2)]);
  const cases = [
    { ...good, metadata: { ...good.metadata, sha256: sha256Hex("other") } },
    {
      ...good,
      metadata: {
        ...good.metadata,
        pages: [
          { index: 5, length: 444 },
          { index: 6, length: 443 },
        ],
      },
    },
    {
      ...good,
      metadata: {
        ...good.metadata,
        pages: [
          { index: 5, length: 444 },
          { index: 7, length: 444 },
        ],
      },
    },
  ];
  for (const sent of cases) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time
    expect((await put(app, 5, sent)).status).toBe(400);
  }
  expect((await put(app, 4, good)).status).toBe(400);
  expect(rows()).toEqual([]);
  expect(app.audio.writes).toBe(0);
});

test("the store down answers 503 with Retry-After and keeps nothing", async () => {
  const app = appWith();
  app.audio.down = true;
  const form = new FormData();
  const { bytes, metadata } = batch(0, [page(1)]);
  form.append("pages", new File([bytes], "pages.bin"));
  form.append("metadata", JSON.stringify(metadata));
  const res = await app.request(`/sources/${SOURCE}/pages/0`, {
    body: form,
    headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    method: "PUT",
  });
  expect(res.status).toBe(503);
  expect(res.headers.get("Retry-After")).toBe("30");
  expect(rows()).toEqual([]);
});

test("a source id can't leave the pages folder, and the disk store refuses `..`", async () => {
  const app = appWith();
  for (const source of ["..", "%2E%2E", "a%2Fb"]) {
    // biome-ignore lint/performance/noAwaitInLoops: one request at a time
    const res = await put(app, 0, batch(0, [page(1)]), OWNER_TOKEN, source);
    expect(res.status).not.toBe(200);
  }
  expect(app.audio.writes).toBe(0);
  const dir = mkdtempSync(join(tmpdir(), "pages-"));
  try {
    const disk = diskAudioStore(dir);
    await expect(disk.put(pagesKey("..", 0, "x"), page(1))).rejects.toThrow();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("only the device token opens ingest", async () => {
  const app = appWith();
  expect((await put(app, 0, batch(0, [page(1)]), READ)).status).toBe(403);
  const res = await app.request(`/sources/${SOURCE}/ingest`, {
    headers: { Authorization: `Bearer ${READ}` },
  });
  expect(res.status).toBe(403);
  expect(rows()).toEqual([]);
});
