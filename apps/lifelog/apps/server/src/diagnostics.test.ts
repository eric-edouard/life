import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { diagnostics, heartbeats } from "@lifelog/db/schema";
import { createApp } from "./app";
import { DEFAULT_TIME_ZONE, ownerTimeZone, setOwnerTimeZone } from "./config";
import {
  appBinaryUUIDs,
  DiagnosticUpload,
  latestHeartbeat,
  ownerZoneAt,
  problemLines,
  reportError,
  serverErrorMessage,
  signatureOf,
  topFrames,
} from "./diagnostics";
import { services } from "./services";
import { OWNER_TOKEN, testConfig, testDb } from "./testing";

const config = testConfig("http://localhost:1");
let env: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  env = testDb();
  app = createApp(services(config, env.db, { intelligence: null }));
});
afterAll(() => env.drop());
beforeEach(() => {
  env.reset();
});

const auth = { Authorization: `Bearer ${OWNER_TOKEN}` };
const post = (path: string, body: unknown) =>
  app.request(path, {
    body: typeof body === "string" ? body : JSON.stringify(body),
    headers: { ...auth, "Content-Type": "application/json" },
    method: "POST",
  });
const get = (path: string) => app.request(path, { headers: auth });

const build = {
  appBuild: "7",
  appVersion: "1.0",
  device: "iPhone17,1",
  os: "iOS 27.0 (24A100)",
};
const frame = (depth: number, offset: number, binaryName = "lifelog") => ({
  address: 0x1_00_00_00_00 + offset,
  binaryName,
  binaryUUID: "8A0F7C3E-1B2D-3C4E-5F60-718293A4B5C6",
  depth,
  offsetIntoBinaryTextSegment: offset,
});
const crash = (id = randomUUID()) => ({
  begin: "2026-10-07T00:00:00.000Z",
  binaries: [{ name: "lifelog", uuid: "8A0F7C3E-1B2D-3C4E-5F60-718293A4B5C6" }],
  build,
  callStacks: [
    { frames: [frame(0, 0x99)], threadAttributed: false },
    {
      frames: [frame(0, 0x10), frame(1, 0x20), frame(2, 0x30), frame(3, 0x40)],
      threadAttributed: true,
    },
  ],
  crash: { exceptionType: 1, signal: 11 },
  end: "2026-10-08T00:00:00.000Z",
  id,
  kind: "crash",
});
const heartbeat = (
  id = randomUUID(),
  observedAt = "2026-10-08T05:00:00.000Z"
) => ({
  build,
  connection: { since: observedAt, state: "ready" },
  id,
  incidents: [],
  observedAt,
  pendant: { batteryPercent: 80 },
  phone: { lowPowerMode: false },
  reason: "periodic",
  recording: { state: "recording" },
  sync: "caught_up",
  wakes: { bytes24h: 0, duplicates24h: 0, last24h: 3, pagesSaved24h: 12 },
});

test("health reporting needs the owner; /health alone stays public", async () => {
  expect((await app.request("/health")).status).toBe(200);
  const statuses = await Promise.all(
    [
      ["POST", "/health/heartbeat"],
      ["POST", "/diagnostics"],
      ["GET", "/diagnostics"],
    ].map(
      async ([method, path]) =>
        (await app.request(path ?? "", { method: method ?? "GET" })).status
    )
  );
  expect(statuses).toEqual([401, 401, 401]);
});

test("a heartbeat is stored once and unknown fields are dropped", async () => {
  expect(latestHeartbeat(env.db)).toBeNull();
  const id = randomUUID();
  const body = { ...heartbeat(id), transcript: "never stored" };
  expect(await (await post("/health/heartbeat", body)).json()).toEqual({
    stored: true,
  });
  expect(await (await post("/health/heartbeat", body)).json()).toEqual({
    stored: false,
  });
  await post(
    "/health/heartbeat",
    heartbeat(randomUUID(), "2026-10-08T01:00:00.000Z")
  );
  const latest = latestHeartbeat(env.db);
  expect(latest?.id).toBe(id);
  expect(latest?.wakes.last24h).toBe(3);
  expect(latest).not.toHaveProperty("transcript");
  expect(latest?.receivedAt).toBeString();
});

test("the owner's zone is the newest heartbeat's that names a valid one", async () => {
  const send = async (time: string, timeZone?: string) =>
    (
      await post("/health/heartbeat", {
        ...heartbeat(randomUUID(), `2026-10-08T${time}:00.000Z`),
        timeZone,
      })
    ).status;
  try {
    const bad = ["Mars/Olympus", "+07:00", "Europe/Berlin'"];
    expect(await Promise.all(bad.map((zone) => send("06:00", zone)))).toEqual([
      400, 400, 400,
    ]);
    expect(await send("05:00")).toBe(200);
    expect(ownerTimeZone()).toBe(DEFAULT_TIME_ZONE);
    expect(await send("06:00", "Europe/Berlin")).toBe(200);
    expect(ownerTimeZone()).toBe("Europe/Berlin");
    // An older heartbeat delivered late, and a newer one from a build that doesn't send it.
    expect(await send("04:00", "Asia/Tokyo")).toBe(200);
    expect(await send("07:00")).toBe(200);
    expect(ownerTimeZone()).toBe("Europe/Berlin");
    // Where he was at an instant: a block recorded then, routed later, uses that zone.
    const at = (time: string) =>
      ownerZoneAt(env.db, new Date(`2026-10-08T${time}:00.000Z`));
    expect(at("04:30")).toBe("Asia/Tokyo");
    expect(at("06:30")).toBe("Europe/Berlin");
    expect(at("03:00")).toBe("Asia/Tokyo");
  } finally {
    setOwnerTimeZone(null);
  }
});

test("invalid uploads are refused with the reason", async () => {
  const bad = await post("/health/heartbeat", {
    ...heartbeat(),
    reason: "bored",
  });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toBe("invalid_request");
  const frames = {
    ...crash(),
    callStacks: [
      { frames: [{ ...frame(0, 1), depth: -1 }], threadAttributed: true },
    ],
  };
  expect((await post("/diagnostics", frames)).status).toBe(400);
  expect((await post("/diagnostics", "{not json")).status).toBe(400);
});

test("bodies over the limit are refused before parsing", async () => {
  const huge = `{"pad":"${"x".repeat(1024 * 1024)}"}`;
  const res = await post("/diagnostics", huge);
  expect(res.status).toBe(413);
  expect((await res.json()).error).toBe("payload_too_large");
  const big = `{"pad":"${"x".repeat(17 * 1024)}"}`;
  expect((await post("/health/heartbeat", big)).status).toBe(413);
});

test("diagnostics list since a time, newest first, with a signature", async () => {
  const id = randomUUID();
  expect(await (await post("/diagnostics", crash(id))).json()).toEqual({
    stored: true,
  });
  expect(await (await post("/diagnostics", crash(id))).json()).toEqual({
    stored: false,
  });
  const listed = await (
    await get("/diagnostics?since=2020-01-01T00:00:00Z")
  ).json();
  expect(listed).toHaveLength(1);
  expect(listed[0].id).toBe(id);
  expect(listed[0].signature).toBe(
    "crash | signal 11 | lifelog+0x10 | lifelog+0x20 | lifelog+0x30"
  );
  expect(listed[0].callStacks[1].frames).toHaveLength(4);
  const later = new Date(Date.now() + 60_000).toISOString();
  expect(await (await get(`/diagnostics?since=${later}`)).json()).toEqual([]);
  expect(await (await get("/diagnostics?kind=hang")).json()).toEqual([]);
  expect(await (await get(`/diagnostics?id=${id}`)).json()).toHaveLength(1);
  expect(await (await get(`/diagnostics?id=${randomUUID()}`)).json()).toEqual(
    []
  );
});

test("rows older than 90 days go when anything new arrives", async () => {
  const days = (n: number) => new Date(Date.now() - n * 24 * 3600 * 1000);
  const row = (receivedAt: Date) => ({
    appBuild: "1",
    appVersion: "1",
    body: {},
    id: randomUUID(),
    kind: "crash" as const,
    receivedAt,
    signature: "s",
  });
  env.db
    .insert(diagnostics)
    .values([row(days(91)), row(days(89))])
    .run();
  env.db
    .insert(heartbeats)
    .values({
      body: {},
      id: randomUUID(),
      observedAt: days(91),
      reason: "periodic",
      receivedAt: days(91),
    })
    .run();
  await post("/health/heartbeat", heartbeat());
  expect(env.db.select().from(diagnostics).all()).toHaveLength(1);
  expect(env.db.select().from(heartbeats).all()).toHaveLength(1);
});

test("the top frames follow the first path down the tree", () => {
  const stack = {
    frames: [frame(0, 1), frame(1, 2), frame(2, 3), frame(1, 4), frame(0, 5)],
    threadAttributed: true,
  };
  expect(topFrames(stack, 5).map((f) => f.offsetIntoBinaryTextSegment)).toEqual(
    [1, 2, 3]
  );
  expect(
    signatureOf({
      ...crash(),
      callStacks: [stack],
      crash: {
        objcException: {
          className: "NSException",
          formatString: "%@",
          name: "NSRangeException",
          type: "NSException",
        },
      },
      kind: "crash",
      truncated: false,
    })
  ).toBe("crash | NSRangeException | lifelog+0x1 | lifelog+0x2 | lifelog+0x3");
});

const appError = (id: string, count: number) => ({
  begin: "2026-10-08T05:00:00.000Z",
  binaries: [{ name: "lifelog", uuid: "8A0F7C3E-1B2D-3C4E-5F60-718293A4B5C6" }],
  build,
  callStacks: [
    { frames: [frame(0, 0x10), frame(1, 0x20)], threadAttributed: true },
  ],
  end: "2026-10-08T05:20:00.000Z",
  error: {
    code: 1,
    count,
    domain: "Processing.TranscriptionClient.ClientError",
    file: "Lifelog/Library/LibraryListStore.swift",
    httpStatus: 503,
    line: 127,
    message: 'server(status: 503, code: "search_unavailable")',
    serverCode: "search_unavailable",
    type: "Processing.TranscriptionClient.ClientError",
  },
  id,
  kind: "app_error",
});

test("an app error's repeats replace it with a higher count", async () => {
  const id = randomUUID();
  expect((await post("/diagnostics", appError(id, 1))).status).toBe(200);
  expect((await post("/diagnostics", appError(id, 4))).status).toBe(200);
  const listed = await (await get("/diagnostics?kind=app_error")).json();
  expect(listed).toHaveLength(1);
  expect(listed[0].error.count).toBe(4);
  expect(listed[0].signature).toBe(
    "app_error | Lifelog/Library/LibraryListStore.swift:127 | " +
      "Processing.TranscriptionClient.ClientError | code 1 | 503 | search_unavailable"
  );
});

test("problem lines name the cause and an error's detail; app binaries are lifelog's", () => {
  const c = DiagnosticUpload.parse(crash());
  expect(problemLines(c)).toEqual(["signal 11; exception type 1"]);
  expect(appBinaryUUIDs(c)).toEqual(["8A0F7C3E-1B2D-3C4E-5F60-718293A4B5C6"]);
  const e = DiagnosticUpload.parse(appError(randomUUID(), 3));
  expect(problemLines(e)).toEqual([
    "Lifelog/Library/LibraryListStore.swift:127  Processing.TranscriptionClient.ClientError  3x since 2026-10-08T05:00:00.000Z",
    "Processing.TranscriptionClient.ClientError 1, HTTP 503, search_unavailable",
    'server(status: 503, code: "search_unavailable")',
  ]);
});

test("a failed query's 500 keeps SQLite's reason and drops its parameters", () => {
  const e = new Error(
    "Failed query: select 1 where id in (?)\nparams: what was said",
    {
      cause: new Error("no such column: b"),
    }
  );
  expect(serverErrorMessage(e)).toBe(
    "no such column: b: Failed query: select 1 where id in (?)"
  );
  expect(serverErrorMessage(new Error("boom"))).toBe("boom");
});

test("a route that throws is answered 500 and kept as a server error", async () => {
  const failing = createApp(
    services(config, env.db, { intelligence: null })
  ).post("/boom/:id", () => {
    throw new Error("relation missing\nparams: secret transcript text");
  });
  const res = await failing.request(`/boom/${randomUUID()}`, {
    body: JSON.stringify({ transcript: "never" }),
    headers: { ...auth, "Content-Type": "application/json" },
    method: "POST",
  });
  expect(res.status).toBe(500);
  expect((await res.json()).error).toBe("internal_error");
  const [stored] = await (await get("/diagnostics?kind=server_error")).json();
  expect(stored.error).toMatchObject({
    httpStatus: 500,
    message: "relation missing",
    method: "POST",
    route: "/boom/:id",
    type: "Error",
  });
  expect(stored.error.stack).toContain("at ");
  expect(JSON.stringify(stored)).not.toContain("secret");
  expect(JSON.stringify(stored)).not.toContain("never");
  expect(stored.signature).toBe("server_error | POST /boom/:id | Error | 500");
});

test("a background step that keeps failing is one server error a day's triage reads, with its count, never a row per try", () => {
  const before = console.error;
  console.error = () => undefined;
  try {
    for (const _ of [1, 2, 3]) {
      reportError(env.db, "reconcile loop", new Error("bucket unreachable"));
    }
  } finally {
    console.error = before;
  }
  const rows = env.db.select().from(diagnostics).all();
  expect(rows).toHaveLength(1);
  const body = rows[0]?.body as DiagnosticUpload;
  expect(body.kind).toBe("server_error");
  expect(body.error?.route).toBe("reconcile loop");
  expect(body.error?.count).toBe(3);
});
