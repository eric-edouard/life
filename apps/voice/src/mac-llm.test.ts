// Summaries on the Mac (provider claude-code): a fake Mac helper on a real Bun socket answers
// the server's `llm` calls; without it runs wait. Nothing reaches a paid API.
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { countRows } from "@life/voice-db";
import {
  conversations,
  intelligenceCalls,
  intelligenceRuns,
  type Turn,
} from "@life/voice-db/schema";
import type { Server } from "bun";
import { eq as is } from "drizzle-orm";
import { createApp } from "./app";
import { sha256Hex } from "./config";
import { MAC_KILL_MS, macAnswer } from "./mac-llm";
import { type MacSocket, macSocket } from "./mac-socket";
import { type ModelCall, macProvider } from "./providers";
import { services } from "./services";
import { subscriptions } from "./subscriptions";
import { latestValid } from "./summaries";
import { loadSwitches, switches } from "./switches";
import {
  fakeAnswer,
  mapJob,
  OWNER_TOKEN,
  seedTranscript,
  testConfig,
  testDb,
} from "./testing";

const MAC_TOKEN = "mac-test-token";
const auth = {
  Authorization: `Bearer ${OWNER_TOKEN}`,
  "Content-Type": "application/json",
};

let env: Awaited<ReturnType<typeof testDb>>;
let mac: MacSocket;
let app: ReturnType<typeof createApp>;
let server: Server<unknown>;
const nudged: string[] = [];
let s: ReturnType<typeof services>;

beforeAll(() => {
  env = testDb();
  const config = testConfig("http://localhost:1", {
    MAC_TOKEN_HASH: sha256Hex(MAC_TOKEN),
  });
  mac = macSocket(env.db, { timeoutMs: 1000 });
  s = services(config, env.db, {
    intelligence: macProvider(mac, () => !switches().ai),
    mac,
    nudge: (ready) => {
      nudged.push(ready);
      return Promise.resolve();
    },
    search: null,
  });
  app = createApp(s);
  server = Bun.serve({ fetch: app.fetch, port: 0, websocket: mac.websocket });
});
afterAll(async () => {
  await server.stop(true);
  env.drop();
});
beforeEach(() => {
  env.reset();
  nudged.length = 0;
  calls.length = 0;
  loadSwitches(env.db);
  mac.resetUnable();
});

// Waits for `ok` to hold; the test timeout bounds it.
async function until<T>(read: () => T | Promise<T>, ok: (value: T) => boolean) {
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: polling
    const value = await read();
    if (ok(value)) {
      return value;
    }
    await Bun.sleep(10);
  }
}

// What `claude -p --output-format json` prints for an answer, as the Mac relays it.
const claudeOutput = (id: unknown, text: string, tokens = [1, 1]) => ({
  id,
  status: 0,
  stderr: "",
  stdout: JSON.stringify({
    is_error: false,
    result: text,
    usage: { input_tokens: tokens[0], output_tokens: tokens[1] },
  }),
  timedOut: false,
  type: "llm.output",
});
// What `codex exec --json` prints, and its final answer file.
const codexOutput = (id: unknown, text: string, tokens = [1, 1]) => ({
  final: text,
  id,
  status: 0,
  stderr: "",
  stdout: JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: tokens[0], output_tokens: tokens[1] },
  }),
  timedOut: false,
  type: "llm.output",
});
// The Mac helper: says hello, then answers each call with `answer`.
type Answer = (call: Record<string, unknown>, ws: WebSocket) => object | null;
const answerWell: Answer = (call) =>
  (call.engine === "codex" ? codexOutput : claudeOutput)(
    call.id,
    JSON.stringify(
      fakeAnswer({
        schema: call.schema as ModelCall["schema"],
        system: String(call.system),
        user: String(call.prompt),
      })
    ),
    [700, 80]
  );
const calls: Record<string, unknown>[] = [];
function fakeMac(answer: Answer = answerWell, running: string[] = []) {
  return new Promise<WebSocket>((resolve, reject) => {
    // Bun's client takes headers; the DOM typing it is merged with doesn't say so.
    const BunSocket = WebSocket as unknown as new (
      url: string,
      options: Bun.WebSocketOptions
    ) => WebSocket;
    const ws = new BunSocket(
      `ws://localhost:${server.port}/quiet-ranges/socket?protocol=2`,
      { headers: { Authorization: `Bearer ${MAC_TOKEN}` } }
    );
    ws.onopen = () => {
      ws.send(
        JSON.stringify({ engines: ["claude", "codex"], running, type: "hello" })
      );
      resolve(ws);
    };
    ws.onerror = () => reject(new Error("refused"));
    ws.onmessage = (event) => {
      const call = JSON.parse(String(event.data));
      if (call.type !== "llm") {
        return;
      }
      calls.push(call);
      const reply = answer(call, ws);
      if (reply) {
        ws.send(JSON.stringify(reply));
      }
    };
  });
}
const away = async (ws: WebSocket) => {
  ws.close();
  await until(mac.live, (live) => live === null);
};

test("the authenticated Mac relays subscription limits and closing its socket keeps them", async () => {
  const ws = await fakeMac();
  const reading = {
    fiveHour: null,
    observedAt: 1_750_000_000,
    sevenDay: { resetsAt: 1_800_600_000, usedPercent: 42 },
  };
  ws.send(
    JSON.stringify({ engine: "codex", reading, type: "subscription.usage" })
  );
  await until(
    () => subscriptions(env.db),
    (value) => value.codex !== null
  );
  await away(ws);
  expect(subscriptions(env.db).codex).toEqual(reading);
});

const turns: Turn[] = Array.from({ length: 3 }, (_, i) => ({
  end: i * 2 + 1.5,
  speakerId: `speaker_${i % 2}`,
  start: i * 2,
  text: "Some words about the plan.",
}));

// Each conversation a day after the one before, so their words never overlap.
let seeded = 0;
function conversation() {
  const id = randomUUID();
  const jobId = seedTranscript(env.db, turns);
  const start = Date.parse("2026-10-01T00:00:00Z") + seeded * 86_400_000;
  seeded += 1;
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(start + 3_600_000),
      captureStartedAt: new Date(start),
      id,
    })
    .run();
  mapJob(env.db, jobId, [[start, start + 3_600_000]]);
  return id;
}
// The owner's Generate as the phone sends it: `regenerate`, after the summary he sees.
const summarize = (id: string, { regenerate = false } = {}) =>
  app.request(`/conversations/${id}/intelligence`, {
    body: JSON.stringify({
      after: regenerate ? (latestValid(env.db, id)?.id ?? null) : null,
    }),
    headers: auth,
    method: "POST",
  });
const runsOf = (id: string) =>
  env.db.query.intelligenceRuns
    .findMany({
      where: (r, { eq }) => eq(r.conversationId, id),
    })
    .sync();
const settledRun = async (id: string, state = "valid") => {
  const run = await until(
    () => runsOf(id)[0],
    (r) => r?.state === state
  );
  if (!run) {
    throw new Error("no run");
  }
  return run;
};

test("the Mac runs the calls: valid on claude-code, its tokens kept, nothing spent", async () => {
  calls.length = 0;
  // A newer helper's extra field changes nothing.
  const ws = await fakeMac((call, socket) => ({
    ...answerWell(call, socket),
    newer: 1,
  }));
  await until(mac.able, Boolean);
  const id = conversation();
  expect((await summarize(id)).status).toBe(202);
  const run = await settledRun(id);
  expect(run).toMatchObject({
    costUsd: 0,
    model: "claude-sonnet-5-5",
    provider: "claude-code",
  });
  expect(run.inputTokens).toBe(700 * calls.length);
  // The exact message the Mac helper parses.
  expect(Object.keys(calls[0] ?? {}).toSorted()).toEqual([
    "engine",
    "id",
    "maxTokens",
    "model",
    "prompt",
    "schema",
    "system",
    "timeoutMs",
    "type",
  ]);
  expect(calls[0]).toMatchObject({
    maxTokens: 16_000,
    model: "claude-sonnet-5-5",
    timeoutMs: MAC_KILL_MS,
    type: "llm",
  });
  expect(typeof calls[0]?.schema).toBe("object");
  await away(ws);
});

test("without the Mac a run waits; the Mac waking drains it", async () => {
  const id = conversation();
  const res = await summarize(id);
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ state: "waiting" });
  // Asking again changes nothing: the run he asked for waits.
  expect((await summarize(id, { regenerate: true })).status).toBe(200);
  expect(runsOf(id)).toHaveLength(1);

  const ws = await fakeMac();
  const run = await settledRun(id);
  expect(run.provider).toBe("claude-code");
  expect(runsOf(id)).toHaveLength(1); // the waiting run started in place
  await until(
    () => nudged,
    (n) => n.includes("summary")
  );
  await away(ws);
});

test("switches: AI off, a run waits with the Mac there and runs once AI is back on; transcription back on nudges the phone", async () => {
  const put = async (body: Record<string, boolean>) =>
    (
      await app.request("/switches", {
        body: JSON.stringify(body),
        headers: auth,
        method: "PUT",
      })
    ).json();
  const ws = await fakeMac();
  expect(await put({ ai: false, transcription: false })).toEqual({
    ai: false,
    engine: "claude",
    openAppAfterMinutes: 15,
    transcription: false,
  });
  const changes = await (
    await app.request("/changes", { headers: auth })
  ).json();
  expect(changes.switches).toEqual({
    ai: false,
    engine: "claude",
    openAppAfterMinutes: 15,
    transcription: false,
  });

  const id = conversation();
  expect(await (await summarize(id)).json()).toMatchObject({
    state: "waiting",
  });
  expect(await put({ ai: true })).toEqual({
    ai: true,
    engine: "claude",
    openAppAfterMinutes: 15,
    transcription: false,
  });
  expect((await settledRun(id)).provider).toBe("claude-code");

  expect(nudged).not.toContain("resumed");
  await put({ transcription: true });
  expect(nudged).toContain("resumed");
  await away(ws);
});

test("the socket closing mid-run puts the run back to waiting, not failed", async () => {
  const ws = await fakeMac((_, socket) => {
    socket.close();
    return null;
  });
  await until(mac.able, Boolean);
  const id = conversation();
  expect((await summarize(id)).status).toBe(202);
  await settledRun(id, "waiting");
  await until(mac.live, (live) => live === null);
  expect(ws.readyState).toBe(WebSocket.CLOSED);
});

test("summaries never reach a paid API: what waits is counted, and only the Mac runs it", async () => {
  const waiting = conversation();
  await summarize(waiting);
  // Valid but on an older prompt version: left alone, the archive is never re-run.
  const older = conversation();
  env.db
    .insert(intelligenceRuns)
    .values({
      conversationId: older,
      model: "gpt-6-luna",
      promptVersion: 4,
      provider: "openai",
      result: {},
      state: "valid",
      turns: [],
    })
    .run();

  expect(
    countRows(env.db, intelligenceRuns, is(intelligenceRuns.state, "waiting"))
  ).toBe(1);
  const forced = await app.request("/intelligence/force", {
    headers: auth,
    method: "POST",
  });
  expect(forced.status).toBe(404);

  const ws = await fakeMac();
  const run = await settledRun(waiting);
  expect(run).toMatchObject({ costUsd: 0, provider: "claude-code" });
  expect(runsOf(older).map((r) => r.provider)).toEqual(["openai"]);
  await away(ws);
});

test("unknown messages are ignored, and the Mac going to sleep makes it unable", async () => {
  const ws = await fakeMac();
  await until(mac.live, (live) => live !== null);
  ws.send(JSON.stringify({ hello: true }));
  // Protocol 1's state message is no event: ignored too.
  ws.send(JSON.stringify({ asleep: true, engines: ["claude"] }));
  expect(mac.able()).toBe(true);
  ws.send(
    JSON.stringify({
      at: new Date().toISOString(),
      seq: 1,
      type: "sleep",
    })
  );
  await until(mac.live, (live) => live?.asleep === true);
  expect(mac.able()).toBe(false);
  await away(ws);
});

// Last: the Mac stays unable for 10 minutes after it.
test("an auth failure makes the Mac unable: runs wait and the feed says why", async () => {
  const ws = await fakeMac((call) => ({
    id: call.id,
    status: 1,
    stderr: "",
    stdout: JSON.stringify({
      is_error: true,
      result: "Invalid API key · Please run /login",
    }),
    timedOut: false,
    type: "llm.output",
  }));
  await until(mac.able, Boolean);
  const id = conversation();
  await summarize(id);
  await settledRun(id, "waiting");
  const feed = await (await app.request("/changes", { headers: auth })).json();
  expect(feed.mac.llm).toEqual({ able: false, reason: "auth" });
  expect(feed.mac.watch).toMatchObject({ asleep: false });
  // Still unable, so the next request waits without asking the Mac.
  const other = conversation();
  expect(await (await summarize(other)).json()).toMatchObject({
    state: "waiting",
  });
  await away(ws);
});

test("Codex uses medium reasoning and stamps every call; a switch doesn't rerun valid work", async () => {
  const changed = await app.request("/switches", {
    body: JSON.stringify({ engine: "codex" }),
    headers: auth,
    method: "PUT",
  });
  expect(await changed.json()).toMatchObject({
    ai: true,
    engine: "codex",
    transcription: true,
  });
  const ws = await fakeMac();
  await until(() => mac.able("codex"), Boolean);
  const id = conversation();
  expect((await summarize(id)).status).toBe(202);
  const run = await settledRun(id);
  expect(run).toMatchObject({
    costUsd: 0,
    model: "gpt-6.1-sol",
    provider: "codex",
    reasoningEffort: "medium",
  });
  expect(run.raw.length).toBeGreaterThan(0);
  for (const call of run.raw) {
    expect(call).toMatchObject({
      model: "gpt-6.1-sol",
      provider: "codex",
      reasoningEffort: "medium",
    });
  }
  for (const call of calls) {
    expect(call).toMatchObject({
      effort: "medium",
      engine: "codex",
      model: "gpt-6.1-sol",
    });
  }
  await app.request("/switches", {
    body: JSON.stringify({ engine: "claude" }),
    headers: auth,
    method: "PUT",
  });
  expect((await summarize(id)).status).toBe(200);
  expect(runsOf(id)).toHaveLength(1);
  await away(ws);
});

test("an engine change between calls keeps the running summary on its original model", async () => {
  let switched = false;
  const ws = await fakeMac((call, socket) => {
    if (switched) {
      return answerWell(call, socket);
    }
    switched = true;
    Promise.resolve(
      app.request("/switches", {
        body: JSON.stringify({ engine: "codex" }),
        headers: auth,
        method: "PUT",
      })
    ).then(() => socket.send(JSON.stringify(answerWell(call, socket))));
    return null;
  });
  await until(mac.able, Boolean);
  const id = conversation();
  await summarize(id);
  const run = await settledRun(id);
  expect(switches().engine).toBe("codex");
  expect(run.provider).toBe("claude-code");
  expect(calls.length).toBeGreaterThan(1);
  for (const call of calls) {
    expect(call.engine).toBe("claude");
  }
  for (const call of run.raw) {
    expect(call.provider).toBe("claude-code");
  }
  await away(ws);
});

test("the Mac gets 4 calls at once, the rest wait; a timeout fails only its own call", async () => {
  const ws = await fakeMac(() => null);
  await until(mac.able, Boolean);
  const ask = (prompt: string) =>
    mac
      .llm({
        engine: "claude",
        maxTokens: 10,
        model: "claude-sonnet-5-5",
        prompt,
        schema: {},
        system: "",
      })
      .then(
        (answer) => answer.text,
        (error: Error) => error.name
      );
  const reply = (prompt: string) => {
    const call = calls.find((c) => c.prompt === prompt);
    ws.send(JSON.stringify(claudeOutput(call?.id, prompt)));
  };
  const replies = Promise.all(["a", "b", "c", "d", "e", "silent"].map(ask));
  await until(
    () => calls.length,
    (n) => n === 4
  );
  await Bun.sleep(50);
  expect(calls).toHaveLength(4);
  for (const prompt of ["a", "b", "c", "d"]) {
    reply(prompt);
  }
  await until(
    () => calls.length,
    (n) => n === 6
  );
  reply("e");
  // "silent" waited for a slot, so its 1 s started late; the others were answered in time.
  expect(await replies).toEqual(["a", "b", "c", "d", "e", "MacGone"]);
  expect(mac.able()).toBe(true);
  await away(ws);
});

const plans = (call: Record<string, unknown>) =>
  Object.keys(
    (call.schema as { properties?: object }).properties ?? {}
  ).includes("boundaries");

test("an answer after its call's timeout is kept, and the resumed run doesn't ask for it again", async () => {
  let late = true;
  const ws = await fakeMac((call, socket) => {
    if (!(plans(call) && late)) {
      return answerWell(call, socket);
    }
    late = false;
    // Past the 1 s timeout: the run waits, then the answer comes.
    setTimeout(
      () => socket.send(JSON.stringify(answerWell(call, socket))),
      1500
    );
    return null;
  });
  await until(mac.able, Boolean);
  const id = conversation();
  expect((await summarize(id)).status).toBe(202);
  await settledRun(id, "waiting");
  await until(
    () => env.db.select().from(intelligenceCalls).all(),
    (kept) => kept.length === 1
  );
  // Asked again, the waiting run is the answer; the next drain resumes it.
  expect((await summarize(id)).status).toBe(200);
  await s.rolling.drain();
  await settledRun(id);
  expect(calls.filter(plans)).toHaveLength(1);
  await away(ws);
});

test("calls the Mac still runs from before (a server restart) hold their slots until they answer", async () => {
  const ws = await fakeMac(() => null, ["old-1", "old-2", "old-3"]);
  await until(mac.able, Boolean);
  const ask = (prompt: string) =>
    mac.llm({
      engine: "claude",
      maxTokens: 10,
      model: "claude-sonnet-5-5",
      prompt,
      schema: {},
      system: "",
    });
  const replies = [ask("a"), ask("b")].map((p) => p.catch(() => null));
  await until(
    () => calls.length,
    (n) => n === 1
  );
  await Bun.sleep(50);
  expect(calls).toHaveLength(1); // 3 of the 4 slots are the Mac's old calls
  ws.send(JSON.stringify(claudeOutput("old-1", "late")));
  await until(
    () => calls.length,
    (n) => n === 2
  );
  for (const call of calls) {
    ws.send(JSON.stringify(claudeOutput(call.id, String(call.prompt))));
  }
  expect((await Promise.all(replies)).map((r) => r?.text)).toEqual(["a", "b"]);
  await away(ws);
});

test("a reconnect keeps the calls the Mac is running: their answers land on the next socket", async () => {
  const first = await fakeMac(() => null);
  await until(mac.able, Boolean);
  const reply = mac.llm({
    engine: "claude",
    maxTokens: 10,
    model: "claude-sonnet-5-5",
    prompt: "p",
    schema: {},
    system: "",
  });
  await until(
    () => calls.length,
    (n) => n === 1
  );
  await away(first);
  const second = await fakeMac(() => null);
  second.send(JSON.stringify(claudeOutput(calls[0]?.id, "kept")));
  expect((await reply).text).toBe("kept");
  await away(second);
});

// What the Mac's raw output means (mac-llm.ts), for each engine.
const claude = (stdout: string, stderr = "", timedOut = false) =>
  macAnswer("claude", { status: 0, stderr, stdout, timedOut });

test("a Claude answer is its structured output, else its result", () => {
  expect(
    claude(
      '{"is_error":false,"result":"ignored","structured_output":{"title":"Lunch"},"usage":{"input_tokens":120,"output_tokens":8}}'
    )
  ).toEqual({
    inputTokens: 120,
    ok: true,
    outputTokens: 8,
    text: '{"title":"Lunch"}',
  });
  expect(
    claude(
      '{"is_error":false,"result":"{\\"a\\":1}","usage":{"input_tokens":1,"output_tokens":2}}'
    )
  ).toEqual({ inputTokens: 1, ok: true, outputTokens: 2, text: '{"a":1}' });
});

test("failures map to auth, limit, timeout or failed", () => {
  const reason = (stdout: string, stderr = "") => {
    const answer = claude(stdout, stderr);
    return answer.ok ? null : answer.reason;
  };
  expect(
    reason(
      '{"is_error":true,"result":"Failed to authenticate: OAuth session expired","api_error_status":null}'
    )
  ).toBe("auth");
  expect(
    reason(
      '{"is_error":true,"result":"Claude AI usage limit reached|1791000000"}'
    )
  ).toBe("limit");
  expect(
    reason('{"is_error":true,"result":"You\'ve hit your limit · resets 3pm"}')
  ).toBe("limit");
  expect(
    reason('{"is_error":true,"result":"Overloaded","api_error_status":429}')
  ).toBe("limit");
  expect(reason('{"is_error":true,"result":"Prompt is too long"}')).toBe(
    "failed"
  );
  // No JSON: stderr says it.
  expect(reason("", "Invalid API key · Please run /login")).toBe("auth");
  expect(reason("", "boom")).toBe("failed");
  expect(claude('{"is_error":false}', "", true)).toEqual({
    detail: "claude ran over 170 s",
    ok: false,
    reason: "timeout",
  });
  // The Mac couldn't start it: signed out is auth, anything else failed.
  expect(
    macAnswer("codex", { signedOut: true, unrun: "sign in: Lifelog Host" })
  ).toMatchObject({ reason: "auth" });
  expect(
    macAnswer("claude", { signedOut: false, unrun: "claude CLI not found" })
  ).toEqual({ detail: "claude CLI not found", ok: false, reason: "failed" });
});

test("a failure's detail is one short line with no key", () => {
  const long = "x".repeat(500);
  const detail = (stdout: string, stderr = "") => {
    const answer = claude(stdout, stderr);
    return answer.ok ? null : answer.detail;
  };
  expect(
    detail(
      JSON.stringify({
        is_error: true,
        result: `bad key sk-ant-oat01-SECRETSECRETSECRET used\n${long}`,
      })
    )
  ).toBe("bad key [redacted] used");
  expect(detail("", "disk-full on task-runner")).toBe(
    "disk-full on task-runner"
  );
  expect(detail("", long)).toHaveLength(200);
});

test("a Codex answer needs a completed turn and keeps its usage", () => {
  const answer = (stream: string, final = "{}", status = 0) =>
    macAnswer("codex", {
      final,
      status,
      stderr: "",
      stdout: stream,
      timedOut: false,
    });
  const events = [
    '{"type":"item.completed","item":{"type":"error","message":"warning"}}',
    '{"type":"turn.completed","usage":{"input_tokens":123,"output_tokens":45}}',
  ].join("\n");
  const ok = {
    inputTokens: 123,
    ok: true as const,
    outputTokens: 45,
    text: "{}",
  };
  expect(answer(events)).toEqual(ok);
  // A stream retry Codex recovered from isn't a failure.
  expect(
    answer(`{"type":"error","message":"Reconnecting... 1/5"}\n${events}`)
  ).toEqual(ok);
  // The final file empty: the last agent message.
  expect(
    answer(
      `{"type":"item.completed","item":{"type":"agent_message","text":"{\\"a\\":1}"}}\n${events}`,
      ""
    )
  ).toMatchObject({ ok: true, text: '{"a":1}' });
  for (const failed of [
    answer(""),
    answer(events, ""),
    answer(events, "{}", 1),
  ]) {
    expect(failed.ok).toBe(false);
  }
  expect(
    answer('{"type":"turn.failed","error":{"message":"usage limit reached"}}')
  ).toMatchObject({ ok: false, reason: "limit" });
});
