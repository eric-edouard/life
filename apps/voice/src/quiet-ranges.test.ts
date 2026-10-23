import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  conversations,
  sources,
  type Turn,
  type Word,
} from "@life/voice-db/schema";
import type { Server } from "bun";
import { createApp } from "./app";
import { sha256Hex } from "./config";
import { textOf } from "./elevenlabs";
import { type MacSocket, macSocket } from "./mac-socket";
import { addQuietRange } from "./quiet-ranges";
import { services } from "./services";
import {
  mapJob,
  OWNER_TOKEN,
  seedTranscript,
  testConfig,
  testDb,
} from "./testing";
import { loadTurns } from "./transcript";

const MAC_TOKEN = "mac-test-token";

let env: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  env = testDb();
  app = createApp(
    services(
      testConfig("http://localhost:1", {
        MAC_TOKEN_HASH: sha256Hex(MAC_TOKEN),
      }),
      env.db,
      { intelligence: null, search: null }
    )
  );
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});

const headers = (token: string) => ({
  Authorization: `Bearer ${token}`,
  "Content-Type": "application/json",
});
const start = Date.parse("2026-10-01T02:00:00Z");
const at = (ms: number) => new Date(start + ms).toISOString();

const post = (body: object, token = OWNER_TOKEN) =>
  app.request("/quiet-ranges", {
    body: JSON.stringify(body),
    headers: headers(token),
    method: "POST",
  });

const range = (from: number, to: number) => ({
  endedAt: at(to),
  id: randomUUID(),
  source: "com.FluidApp.app",
  startedAt: at(from),
});

test("the phone posts its playback ranges with its device token; the Mac's token opens nothing but its socket", async () => {
  expect((await post(range(0, 1000), MAC_TOKEN)).status).toBe(401);
  expect((await post(range(0, 1000), "nope")).status).toBe(401);
  expect((await post({ ...range(0, 1000), source: "playback" })).status).toBe(
    200
  );
  const feed = await app.request("/changes", { headers: headers(MAC_TOKEN) });
  expect(feed.status).toBe(401);
});

test("a retried post is stored once and answers the same", async () => {
  const body = range(1000, 5000);
  const first = await post(body);
  const again = await post({ ...body, endedAt: at(9000) });
  expect(await again.json()).toEqual(await first.json());
  const rows = env.db.$client.query("select id from quiet_ranges").all();
  expect(rows.length).toBe(1);
});

test("Mac dictation marks the Pendant's grouping dirty; playback doesn't", () => {
  env.db.insert(sources).values({ id: "dev1" }).run();
  const dirty = () => env.db.select().from(sources).all()[0]?.dirtyFrom ?? null;
  addQuietRange(env.db, { ...range(1000, 5000), source: "playback" });
  expect(dirty()).toBeNull();
  addQuietRange(env.db, {
    ...range(6000, 9000),
    source: "com.apple.dictation",
  });
  expect(dirty()).not.toBeNull();
});

test("a range that ends first or lasts over 11 minutes is refused", async () => {
  expect((await post(range(5000, 1000))).status).toBe(400);
  expect((await post(range(0, 12 * 60_000))).status).toBe(400);
});

test("the feed carries new quiet ranges", async () => {
  const body = range(2000, 9000);
  await post(body);
  const res = await app.request("/changes", { headers: headers(OWNER_TOKEN) });
  const feed = (await res.json()) as { quietRanges: object[] };
  expect(feed.quietRanges).toEqual([
    { endedAt: body.endedAt, id: body.id, startedAt: body.startedAt },
  ]);
});

// The Mac helper's socket, on a real Bun server: its events become ranges, and the open socket
// vouches for time.
let mac: MacSocket;
let live: ReturnType<typeof createApp>;
let server: Server<unknown>;

beforeAll(() => {
  mac = macSocket(env.db);
  live = createApp(
    services(
      testConfig("http://localhost:1", {
        MAC_TOKEN_HASH: sha256Hex(MAC_TOKEN),
      }),
      env.db,
      { intelligence: null, mac, search: null }
    )
  );
  server = Bun.serve({ fetch: live.fetch, port: 0, websocket: mac.websocket });
});
afterAll(async () => {
  await server.stop(true);
});

const open = (token = MAC_TOKEN, protocol = "2") =>
  new Promise<WebSocket>((resolve, reject) => {
    // Bun's client takes headers; the DOM typing it is merged with doesn't say so.
    const BunSocket = WebSocket as unknown as new (
      url: string,
      options: Bun.WebSocketOptions
    ) => WebSocket;
    const ws = new BunSocket(
      `ws://localhost:${server.port}/quiet-ranges/socket?protocol=${protocol}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("refused"));
  });
const hello = (ws: WebSocket) =>
  ws.send(JSON.stringify({ engines: ["claude"], type: "hello" }));
// The Mac's events, at real times: the rules let a flag go 10 minutes after it came on. Each has the
// helper's next seq.
let seq = 0;
const nextSeq = () => {
  seq += 1;
  return seq;
};
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();
const mic = (when: string, ...capturing: string[]) => ({
  at: when,
  capturing,
  seq: nextSeq(),
  type: "mic",
});
const sleep = (when: string) => ({ at: when, seq: nextSeq(), type: "sleep" });
const send = (ws: WebSocket, ...events: object[]) => {
  for (const event of events) {
    ws.send(JSON.stringify(event));
  }
};
// What the helper gets back: the welcome, then acks.
interface Frame {
  lastSeq?: number;
  seq?: number;
  type: string;
}
const frames = (ws: WebSocket) => {
  const got: Frame[] = [];
  ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
  return got;
};
const acked = async (got: Frame[], n: number) => {
  for (let i = 0; i < 100; i += 1) {
    if (got.some((f) => f.type === "ack" && f.seq === n)) {
      return true;
    }
    // biome-ignore lint/performance/noAwaitInLoops: polling
    await Bun.sleep(10);
  }
  return false;
};
const stored = () =>
  env.db.$client
    .query("select started_at, ended_at, source from quiet_ranges")
    .all() as { ended_at: number; source: string; started_at: number }[];
interface Mac {
  asleep: boolean;
  heardAt: string;
  watchedThrough: string;
}
const macInFeed = async () => {
  const res = await live.request("/changes", { headers: headers(OWNER_TOKEN) });
  return ((await res.json()) as { mac: { watch: Mac | null } }).mac.watch;
};
// The socket is asynchronous: waits until the feed shows what the test expects.
const feedWhen = async (
  ok: (mac: Mac | null) => boolean,
  tries = 200
): Promise<Mac | null> => {
  const seen = await macInFeed();
  if (ok(seen)) {
    return seen;
  }
  if (tries === 0) {
    throw new Error(`the feed never showed it: ${JSON.stringify(seen)}`);
  }
  await Bun.sleep(10);
  return feedWhen(ok, tries - 1);
};
const closed = async (ws: WebSocket) => {
  ws.close();
  await feedWhen(() => mac.live() === null);
};
const through = (m: Mac | null) => Date.parse(String(m?.watchedThrough));
const eventsNamed = (name: string) =>
  env.db.$client
    .query("select fields from events where name = ?")
    .all(name) as { fields: string }[];

test("only the Mac's token opens the socket, and only a helper of this protocol", async () => {
  await expect(open(OWNER_TOKEN)).rejects.toThrow("refused");
  await expect(open("nope")).rejects.toThrow("refused");
  const plain = await live.request("/quiet-ranges/socket?protocol=2", {
    headers: headers(MAC_TOKEN),
  });
  expect(plain.status).toBe(426);
  // A helper of protocol 1 (ranges and answers) is told so, never misread.
  const old = await live.request("/quiet-ranges/socket", {
    headers: headers(MAC_TOKEN),
  });
  expect(old.status).toBe(426);
  expect(await old.text()).toContain("protocol 2, not 1");
  await expect(open(MAC_TOKEN, "1")).rejects.toThrow("refused");
});

test("open, the Mac vouches through now; closed, the watermark freezes at the last word heard", async () => {
  const ws = await open();
  expect(await macInFeed()).toBeNull(); // nothing said yet
  hello(ws);
  const first = await feedWhen((m) => m !== null);
  expect(Date.now() - through(first)).toBeLessThan(1000);
  await Bun.sleep(30);
  const later = await macInFeed();
  expect(through(later)).toBeGreaterThan(through(first));
  await closed(ws);
  const frozen = await macInFeed();
  expect(frozen?.watchedThrough).toBe(frozen?.heardAt);
  await Bun.sleep(30);
  expect(await macInFeed()).toEqual(frozen);
});

test("a Mac clock running ahead never vouches for, holds or stores in the future", async () => {
  const ws = await open();
  const got = frames(ws);
  hello(ws);
  const inAnHour = (ms = 0) =>
    new Date(Date.now() + 3_600_000 + ms).toISOString();
  const on = mic(inAnHour(), "com.FluidApp.app");
  send(ws, on);
  expect(await acked(got, on.seq)).toBe(true);
  // Its time is capped at the server's now, so is the dictation it opens.
  expect(Date.parse(String(mac.dictatingSince()))).toBeLessThanOrEqual(
    Date.now()
  );
  const ahead = mic(inAnHour(1000));
  send(ws, ahead);
  expect(await acked(got, ahead.seq)).toBe(true);
  await closed(ws);
  // Closing stored it, ending no later than the server's now plus its padding.
  expect(stored()).toHaveLength(1);
  expect(stored()[0]?.ended_at).toBeLessThanOrEqual(Date.now() + 1500);
  const frozen = await macInFeed();
  expect(Date.parse(String(frozen?.heardAt))).toBeLessThanOrEqual(Date.now());
  expect(through(frozen)).toBeLessThanOrEqual(Date.now());
});

test("a dictation app's microphone becomes a padded range once the merge gap passed; other apps are counted, never named", async () => {
  const ws = await open();
  const got = frames(ws);
  hello(ws);
  const on = mic(ago(60_000), "com.apple.FaceTime", "com.FluidApp.app");
  send(ws, on);
  expect(await acked(got, on.seq)).toBe(true);
  // Dictating: held at its padded start, and the feed says since when.
  const held = await feedWhen((m) => through(m) === Date.parse(on.at) - 1000);
  expect(held?.asleep).toBe(false);
  expect(mac.dictatingSince()).toBe(on.at);
  const off = mic(ago(50_000), "com.apple.FaceTime");
  send(ws, off);
  expect(await acked(got, off.seq)).toBe(true);
  // Its gap passed long ago: stored at once, and the watermark is free.
  await feedWhen((m) => Date.now() - through(m) < 1000);
  expect(stored()).toEqual([
    {
      ended_at: Date.parse(off.at) + 1500,
      source: "com.FluidApp.app",
      started_at: Date.parse(on.at) - 1000,
    },
  ]);
  expect(mac.dictatingSince()).toBeNull();
  const told = eventsNamed("mac.event").map((e) => JSON.parse(e.fields));
  expect(told).toEqual([
    { dictating: "com.FluidApp.app", kind: "mic", others: 1 },
    { dictating: "", kind: "mic", others: 1 },
  ]);
  const all = env.db.$client.query("select fields from events").all();
  expect(JSON.stringify(all)).not.toContain("FaceTime");
  await closed(ws);
});

test("an event is applied once: a resend after a lost ack is acked again and changes nothing", async () => {
  const ws = await open();
  const got = frames(ws);
  hello(ws);
  const on = mic(ago(30_000), "claude");
  const off = mic(ago(20_000));
  send(ws, on, off);
  expect(await acked(got, off.seq)).toBe(true);
  await feedWhen(() => stored().length === 1);
  send(ws, on, off);
  await feedWhen(() => got.filter((f) => f.type === "ack").length === 4);
  expect(stored()).toHaveLength(1);
  expect(mac.dictatingSince()).toBeNull();
  await closed(ws);
});

test("a socket dropped mid-dictation never vouches past it, through the reconnect, until the range is stored", async () => {
  const first = await open();
  hello(first);
  const on = mic(ago(40_000), "com.FluidApp.app");
  send(first, on);
  const heldAt = Date.parse(on.at) - 1000;
  await feedWhen((m) => through(m) === heldAt);
  // The network drops: no sleep, no off yet.
  await closed(first);
  expect(through(await macInFeed())).toBe(heldAt);
  // Back: the outbox goes first, then the hello; only the off frees it.
  const second = await open();
  send(second, on);
  hello(second);
  await Bun.sleep(30);
  expect(through(await macInFeed())).toBe(heldAt);
  send(second, mic(ago(30_000)));
  await feedWhen((m) => through(m) > Date.parse(on.at));
  expect(stored()).toHaveLength(1);
  await closed(second);
});

test("a socket closing stores a dictation still waiting for a neighbour at once", async () => {
  const ws = await open();
  hello(ws);
  const on = mic(ago(2000), "com.FluidApp.app");
  const off = mic(ago(1000));
  send(ws, on, off);
  await feedWhen((m) => through(m) === Date.parse(on.at) - 1000);
  expect(stored()).toHaveLength(0);
  await closed(ws);
  expect(stored()).toHaveLength(1);
  const frozen = await macInFeed();
  expect(frozen?.watchedThrough).toBe(frozen?.heardAt);
});

test("an invalid event blocks the watermark however long the Mac is silent, and the span it was dropped from becomes a range", async () => {
  const first = await open();
  const got = frames(first);
  hello(first);
  const on = mic(ago(40_000), "com.FluidApp.app");
  send(first, on);
  await feedWhen((m) => through(m) === Date.parse(on.at) - 1000);
  const shut = new Promise((resolve) => {
    first.onclose = resolve;
  });
  const bad = { ...mic(ago(30_000)), at: "yesterday" };
  send(first, bad, mic(ago(20_000)));
  await shut;
  await feedWhen(() => mac.live() === null);
  expect(got.filter((f) => f.type === "ack")).toHaveLength(1);
  expect(stored()).toHaveLength(0);
  // Stuck, and visibly so; 3 hours of silence free nothing past the block.
  const since = mac.stuckSince();
  expect(since).not.toBeNull();
  expect(eventsNamed("mac.stuck")).toHaveLength(1);
  const later = new Date(Date.now() + 3 * 3_600_000);
  expect(mac.vouchedThrough(later).getTime()).toBeLessThanOrEqual(
    since?.getTime() ?? 0
  );
  // The helper dropped the invalid one (it may have been a dictation's start, T1). Its next good event
  // (T2) clears the block, and the span from the block to T2 becomes a range of unknown source:
  // nothing in it is released.
  const second = await open();
  const t2 = mic(new Date().toISOString());
  send(second, t2);
  hello(second);
  await feedWhen(() => mac.stuckSince() === null && mac.live() !== null);
  const unknown = stored().find((r) => r.source === "unknown");
  expect(unknown?.started_at).toBe(since?.getTime() ?? -1);
  expect(unknown?.ended_at).toBeGreaterThanOrEqual(Date.parse(t2.at));
  await closed(second);
  // The dictation it was in goes too, once the socket closes.
  expect(
    stored()
      .map((r) => r.source)
      .toSorted()
  ).toEqual(["com.FluidApp.app", "unknown"]);
});

test("the welcome says the last seq applied; a lower seq sent later is refused and blocks, never dropped", async () => {
  const first = await open();
  const welcomes = frames(first);
  hello(first);
  const on = mic(ago(30_000), "claude");
  send(first, on);
  expect(await acked(welcomes, on.seq)).toBe(true);
  expect(welcomes[0]).toEqual({ lastSeq: 0, type: "welcome" });
  await closed(first);
  // The helper lost its file and its clock runs behind: a new event numbered below what was applied.
  const second = await open();
  const got = frames(second);
  const shut = new Promise((resolve) => {
    second.onclose = resolve;
  });
  await Bun.sleep(30);
  expect(got[0]).toEqual({ lastSeq: on.seq, type: "welcome" });
  const behind = { ...mic(ago(20_000)), seq: on.seq - 1 };
  send(second, behind);
  await shut;
  expect(got.filter((f) => f.type === "ack")).toHaveLength(0);
  expect(eventsNamed("mac.seq_behind")).toHaveLength(1);
  expect(mac.stuckSince()).not.toBeNull();
  // Numbered above the welcome's, as the helper does, it applies, and the block clears.
  const third = await open();
  send(third, { ...behind, seq: on.seq + 1 });
  hello(third);
  await feedWhen(() => mac.stuckSince() === null && mac.live() !== null);
  expect(stored()).toHaveLength(1);
  // A true resend (same seq, same time) is acked and changes nothing.
  const resent = frames(third);
  send(third, on);
  expect(await acked(resent, on.seq)).toBe(true);
  expect(mac.stuckSince()).toBeNull();
  await closed(third);
});

test("events applied whose acks were lost come again with their seqs and change nothing, out of order or not", async () => {
  const first = await open();
  hello(first);
  const off = mic(ago(30_000)); // T1
  const on = mic(ago(20_000), "com.FluidApp.app"); // T2
  send(first, off, on);
  await feedWhen(() => mac.dictatingSince() === on.at);
  await closed(first);
  // Both acks were lost: the helper keeps their seqs (its file was numbered by a welcome) and sends both again.
  const second = await open();
  const got = frames(second);
  send(second, off, on);
  hello(second);
  expect(await acked(got, on.seq)).toBe(true);
  // The off at T1 didn't close the dictation from T2: still held there, nothing stored.
  expect(mac.dictatingSince()).toBe(on.at);
  expect(through(await macInFeed())).toBe(Date.parse(on.at) - 1000);
  expect(stored()).toHaveLength(0);
  await closed(second);
});

test("sleep cuts a dictation; asleep, the Mac vouches through now; its hello wakes it", async () => {
  const ws = await open();
  hello(ws);
  send(
    ws,
    mic(ago(60_000), "com.FluidApp.app"),
    mic(ago(58_000)),
    mic(ago(50_000), "com.FluidApp.app"),
    sleep(ago(49_000))
  );
  // The first goes at sleep, padded; the one cut by sleep is dropped.
  await feedWhen(() => stored().length === 1);
  await closed(ws);
  const asleep = await macInFeed();
  expect(asleep?.asleep).toBe(true);
  expect(mac.vouchedThrough().getTime()).toBeGreaterThan(Date.now() - 1000);
  const again = await open();
  hello(again);
  await feedWhen((m) => m?.asleep === false && mac.live() !== null);
  // The flag still on after the wake is ignored until it goes off.
  send(again, mic(ago(1000), "com.FluidApp.app"));
  await Bun.sleep(30);
  expect(mac.dictatingSince()).toBeNull();
  expect(stored()).toHaveLength(1);
  await closed(again);
});

// Seconds of prepared audio map to `start` plus as many seconds (one segment).
const word = (
  text: string,
  from: number,
  to: number,
  speaker: string,
  spacing = " "
) =>
  ({
    end: to,
    logprob: null,
    spacing,
    speakerId: speaker,
    start: from,
    text,
  }) satisfies Word;
const turnOf = (words: Word[]): Turn => ({
  end: words.at(-1)?.end ?? 0,
  speakerId: words[0]?.speakerId ?? null,
  start: words[0]?.start ?? 0,
  text: textOf(words),
});
// Thai as Scribe sends it: a token per letter cluster, unspaced, "สี่วัน อ๋อ".
const thai = ["สี่", "วั", "น", " อ๋", "อ"].map((text, i) =>
  word(
    text.trim(),
    16 + i,
    16.5 + i,
    "speaker_1",
    text.startsWith(" ") ? " " : ""
  )
);

// A conversation's words as every reader gets them: speaker and kept text, one turn a line.
const transcript = (id: string) =>
  `${loadTurns(env.db, id)
    ?.turns.map((t) => `${t.speaker}: ${t.text}`)
    .join("\n")}\n`;

test("words inside a quiet range are hidden from fetch; a turn left empty goes", async () => {
  const lines = [
    [
      word("Call", 0, 0.5, "speaker_0"),
      word("the", 0.6, 1, "speaker_0"),
      word("plumber", 1.1, 1.8, "speaker_0"),
      word("about", 2.5, 3, "speaker_0"),
      word("Monday", 3.2, 4, "speaker_0"),
    ],
    [
      word("Write", 5, 5.5, "speaker_1"),
      word("to", 5.6, 6, "speaker_1"),
      word("Anna", 6.2, 9, "speaker_1"),
    ],
    [
      word("Sounds", 12, 12.5, "speaker_0"),
      word("good", 12.6, 14, "speaker_0"),
    ],
    thai,
  ];
  const id = randomUUID();
  const jobId = seedTranscript(env.db, lines.map(turnOf), lines.flat());
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(start + 600_000),
      captureStartedAt: new Date(start),
      id,
    })
    .run();
  mapJob(env.db, jobId, [[start, start + 600_000]]);
  expect(transcript(id)).toContain("Anna");

  await post(range(2200, 10_000));
  const text = transcript(id);
  expect(text).toContain("Speaker 1: Call the plumber\n");
  expect(text).not.toContain("Monday");
  expect(text).not.toContain("Anna");
  expect(text).toContain("Speaker 1: Sounds good");
  expect(text).toContain("Speaker 2: สี่วัน อ๋อ");

  // A cut through a Thai turn keeps the provider's spacing: no space between letters.
  await post(range(16_900, 18_100));
  expect(transcript(id)).toContain("Speaker 2: สี่ อ๋อ\n");
});
