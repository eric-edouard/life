import { afterAll, beforeEach, expect, test } from "bun:test";
import { setSettings } from "../core/settings";
import { agentInRole, openTurn } from "../host/desk-read";
import { MAIN_SESSION_PATH } from "../host/http/http";
import { localKey } from "../host/http/local-key";
import type { MainSessionLine } from "../records/main-session";
import { wakeDue } from "./desk-clock";
import { doorFetch, doorOf } from "./desk-door";
import { askMainSession, MAIN_BRIEF } from "./main-session";
import { setup } from "./test-desk";

// The main session (Tell Life, slice 1): registered on his first words, one desk turn per ask on a session the runtime
// keeps, its lines heard as they come, its answer the words after its last tool call; one ask at a time, a retry under
// its key asks once, never woken by the clock, every door tool refused on its turn. Made-up words.

let t = setup();
beforeEach(() => {
  t = setup();
  t.desk.runtimes = { claude: t.fake.runtime };
  setSettings({ desk: { defaultRuntime: "claude", runtimes: {} } });
});
afterAll(() => setSettings({ desk: null }));

const main = () => agentInRole(t.desk.db, "main");
const turnsOf = (id: string) =>
  t.desk.db
    .query<
      { cause: string; ended_at: string | null; outcome: string },
      [string]
    >(
      "select cause, outcome, ended_at from turn where agent_id = ? order by id"
    )
    .all(id);

/** Asks `words`, then plays the session: `play` (its updates) and its run's end. */
async function asked(words: string, play: (ref: string) => void, key?: string) {
  const lines: MainSessionLine[] = [];
  const answer = askMainSession(t.desk, { key, words }, (l) => lines.push(l));
  // Let the ask reach the runtime.
  for (let i = 0; i < 20 && !t.fake.said.length; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: a poll
    await Bun.sleep(5);
  }
  const ref = t.fake.said.at(-1)?.ref ?? "";
  play(ref);
  t.fake.exit(ref, true, {
    usage: {
      contextFirst: 10,
      contextLast: 20,
      tokensCached: 1,
      tokensIn: 2,
      tokensOut: 3,
    },
  });
  return { answer: await answer, lines, ref };
}

test("his first words register the main session and start its session from its brief and his words; the answer is its text after its last tool call; the turn ends answered with its tokens", async () => {
  const { answer, lines, ref } = await asked("Where is my passport?", (r) => {
    t.fake.hear(r, { kind: "words", text: "Let me look." });
    t.fake.hear(r, {
      id: "c1",
      kind: "working",
      state: "pending",
      title: "fetch",
    });
    t.fake.hear(r, { kind: "words", text: "In the drawer, " });
    t.fake.hear(r, { kind: "words", text: "by your notes." });
  });
  expect(answer).toEqual({
    kind: "reply",
    words: "In the drawer, by your notes.",
  });
  expect(lines.map((l) => l.kind)).toEqual([
    "words",
    "working",
    "words",
    "words",
  ]);
  const a = main();
  expect(a).toMatchObject({ role: "main", session: ref, status: "active" });
  expect(t.fake.said[0]?.message).toStartWith(MAIN_BRIEF);
  expect(t.fake.said[0]?.message).toContain(
    'His words, through Tell Life: "Where is my passport?"'
  );
  await Bun.sleep(0);
  expect(turnsOf(a?.id ?? "")).toEqual([
    { cause: "main_ask", ended_at: expect.any(String), outcome: "answered" },
  ]);
  expect(t.desk.db.query("select tokens_out from turn").get()).toEqual({
    tokens_out: 3,
  });
});

test("his next words go to the same session without its brief, with his screen's refs; the clock never wakes it", async () => {
  const first = await asked("Hello", (r) =>
    t.fake.hear(r, { kind: "words", text: "Hi." })
  );
  await wakeDue(t.desk);
  expect(t.fake.said).toHaveLength(1);
  const lines: MainSessionLine[] = [];
  const next = askMainSession(
    t.desk,
    { screen: { open: "matter:mat_x", tab: "inbox" }, words: "And this one?" },
    (l) => lines.push(l)
  );
  await Bun.sleep(5);
  expect(t.fake.said[1]).toEqual({
    message:
      'His words, through Tell Life: "And this one?"\nOn his screen (refs; `fetch` opens one): {"open":"matter:mat_x","tab":"inbox"}',
    ref: first.ref,
  });
  t.fake.hear(first.ref, { kind: "words", text: "It waits on Ana." });
  t.fake.exit(first.ref);
  expect(await next).toEqual({ kind: "reply", words: "It waits on Ana." });
  expect(agentInRole(t.desk.db, "main")?.id).toBe(main()?.id);
});

test("one ask at a time; a retry under its key replays its lines and ends with the same answer, asking once", async () => {
  const lines: MainSessionLine[] = [];
  const first = askMainSession(t.desk, { key: "k1", words: "One" }, (l) =>
    lines.push(l)
  );
  await Bun.sleep(5);
  const ref = t.fake.said[0]?.ref ?? "";
  t.fake.hear(ref, { kind: "words", text: "Yes." });
  expect(
    await askMainSession(t.desk, { words: "Two" }, () => undefined)
  ).toEqual({
    kind: "error",
    what: "Life is still answering your last words.",
  });
  const replayed: MainSessionLine[] = [];
  const retry = askMainSession(t.desk, { key: "k1", words: "One" }, (l) =>
    replayed.push(l)
  );
  t.fake.hear(ref, { kind: "words", text: " Done." });
  t.fake.exit(ref);
  expect(await first).toEqual({ kind: "reply", words: "Yes. Done." });
  expect(await retry).toEqual({ kind: "reply", words: "Yes. Done." });
  expect(replayed).toEqual(lines);
  expect(t.fake.said).toHaveLength(1);
});

test("a failed run answers an error and ends its turn failed; a run with no words answers that it gave none", async () => {
  const { answer } = await asked("Hello", (r) =>
    t.fake.hear(r, { kind: "thinking" })
  );
  expect(answer).toEqual({ kind: "error", what: "Life gave no answer." });
  const failing = askMainSession(t.desk, { words: "Again" }, () => undefined);
  await Bun.sleep(5);
  t.fake.exit(t.fake.said[1]?.ref ?? "", false, { why: "rate_limit" });
  expect(await failing).toEqual({ kind: "error", what: "rate_limit" });
  await Bun.sleep(0);
  expect(turnsOf(main()?.id ?? "").map((x) => x.outcome)).toEqual([
    "answered",
    "failed",
  ]);
});

test("the door: his words by the local key stream NDJSON lines then the answer; no words keeps the session; a wrong key is refused; on its turn every door tool is refused", async () => {
  const fetchDoor = doorFetch(t.desk);
  const post = (body: unknown, key = localKey()) =>
    fetchDoor(
      new Request(`http://127.0.0.1${MAIN_SESSION_PATH}`, {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${key}` },
        method: "POST",
      })
    );
  expect((await post({ words: "Hi" }, "wrong")).status).toBe(401);
  const res = await post({ words: "Hi" });
  await Bun.sleep(5);
  const ref = t.fake.said[0]?.ref ?? "";
  t.fake.hear(ref, { kind: "words", text: "Hello." });
  // On its turn, the door refuses it its tools.
  const id = main()?.id ?? "";
  expect(openTurn(t.desk.db, id)?.cause).toBe("main_ask");
  const call = await fetchDoor(
    new Request(`http://127.0.0.1/mcp/${id}`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: { outcome: "done" }, name: "finish" },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${doorOf(id).key}`,
        "content-type": "application/json",
      },
      method: "POST",
    })
  );
  expect(await call.text()).toContain("only reads and answers him");
  t.fake.exit(ref);
  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  expect(lines).toEqual([
    { kind: "words", text: "Hello." },
    { answer: { kind: "reply", words: "Hello." }, kind: "answer" },
  ]);
  expect(await (await post({})).json()).toEqual({ kept: true });
  expect(t.fake.kept).toEqual([ref]);
});
