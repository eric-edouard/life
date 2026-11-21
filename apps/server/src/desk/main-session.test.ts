import { afterAll, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { clock } from "../core/clock";
import { DESK_AGENT, OWNER_ASKER } from "../core/names";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { ask } from "../host/asks";
import { requested } from "../host/change-todo-item";
import {
  agentChangeOf,
  agentInRole,
  agentOf,
  agentWaitOf,
  currentAssignmentOf,
  openTurn,
} from "../host/desk-read";
import { MAIN_SESSION_PATH } from "../host/http/http";
import { localKey } from "../host/http/local-key";
import { MOVE_REASONS } from "../host/move-read";
import { decisionsNow } from "../memory/decisions";
import { LEDGER, readLedger } from "../memory/memory-files";
import { complaintOf, isComplaint } from "../records/ledger-entry";
import type { MainSessionLine } from "../records/main-session-wire";
import type { AgentChange } from "../records/registered-agent";
import { openAssignment, register } from "./agent-actions";
import { applyAgentChanges } from "./agent-changes";
import { receiveComplaints } from "./complaint-intake";
import { wakeDue } from "./desk-clock";
import { doorFetch } from "./desk-door";
import { openDesk } from "./desk-store";
import { doorOf } from "./door-keys";
import { askMainSession, keepMainSession, MAIN_BRIEF } from "./main-session";
import { ownAssignmentOf } from "./role-agents";
import { SessionLive } from "./runtimes/contract";
import { readSpokenAsk, receiveSpokenAsks } from "./spoken-ask-intake";
import { setup } from "./test-desk";
import { endLostTurns } from "./turn-ends";

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
async function asked(
  words: string,
  play: (ref: string) => unknown,
  key?: string
) {
  const lines: MainSessionLine[] = [];
  const answer = askMainSession(t.desk, { key, words }, (l) => lines.push(l));
  // Let the ask reach the runtime.
  for (let i = 0; i < 20 && !t.fake.said.length; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: a poll
    await Bun.sleep(5);
  }
  const ref = t.fake.said.at(-1)?.ref ?? "";
  await play(ref);
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

test("his first words register the main session and start its session from its brief and his words; the answer is its text after its last tool call; the turn ends replied with its tokens", async () => {
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
    { cause: "main_ask", ended_at: expect.any(String), outcome: "replied" },
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

test("an ask its session would not take keeps no retry key: the retry asks again; the main session holds no wait", async () => {
  await asked("Hello", (r) => t.fake.hear(r, { kind: "words", text: "Hi." }));
  const { talk } = t.fake.runtime;
  t.fake.runtime.talk = () =>
    Promise.reject(new SessionLive("session is running"));
  expect(
    await askMainSession(t.desk, { key: "k", words: "Again" }, () => undefined)
  ).toEqual({
    kind: "error",
    what: "Life's main session is busy or closed: send your words again.",
  });
  t.fake.runtime.talk = talk;
  const again = askMainSession(
    t.desk,
    { key: "k", words: "Again" },
    () => undefined
  );
  await Bun.sleep(5);
  const ref = t.fake.said.at(-1)?.ref ?? "";
  expect(t.fake.said.at(-1)?.message).toContain('"Again"');
  t.fake.hear(ref, { kind: "words", text: "Hi again." });
  t.fake.exit(ref);
  expect(await again).toEqual({ kind: "reply", words: "Hi again." });
  const a = main();
  const s = a && currentAssignmentOf(t.desk.db, a.id);
  expect(a && s && agentWaitOf(a, s)).toBeNull();
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
    "replied",
    "failed",
  ]);
});

test("the door: his words by the local key stream NDJSON lines then the answer; no words keeps the session; a wrong key is refused; on its turn every other door tool is refused", async () => {
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
  expect(await call.text()).toContain("acts only on a turn of his words");
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

/** A made-up card. */
const card = (question: string) => ({
  context: "A made-up reason to ask.",
  deadline: new Date(clock().getTime() + 86_400_000).toISOString(),
  options: [
    { id: "yes", label: "Yes" },
    { id: "no", label: "No" },
  ],
  question,
  title: "a test",
});

/** Agent `id` calls door tool `name` with `args`; the call's response text. */
async function callDoor(id: string, name: string, args: unknown) {
  const res = await doorFetch(t.desk)(
    new Request(`http://127.0.0.1/mcp/${id}`, {
      body: JSON.stringify({
        id: 1,
        jsonrpc: "2.0",
        method: "tools/call",
        params: { arguments: args, name },
      }),
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${doorOf(id).key}`,
        "content-type": "application/json",
      },
      method: "POST",
    })
  );
  return await res.text();
}

test("`answer` adds why to its words, or likely answers that make it a question; a dead source is refused; its words stay its text after its last tool call", async () => {
  const play = (extras: unknown) => async (r: string) => {
    expect(await callDoor(main()?.id ?? "", "answer", extras)).not.toContain(
      "Not done"
    );
    t.fake.hear(r, { kind: "words", text: "**Friday**, at ten." });
  };
  const said = async (words: string, extras: unknown) =>
    (await asked(words, play(extras))).answer;
  expect(
    await said("When is the fitting?", { why: "Since his mail of 2 October." })
  ).toEqual({
    kind: "reply",
    why: "Since his mail of 2 October.",
    words: "**Friday**, at ten.",
  });
  // A later call replaces the earlier one.
  const twice = await asked("And the fitting?", async (r) => {
    await callDoor(main()?.id ?? "", "answer", { answers: ["A", "B"] });
    await play({ why: "Replaced." })(r);
  });
  expect(twice.answer).toEqual({
    kind: "reply",
    why: "Replaced.",
    words: "**Friday**, at ten.",
  });
  expect(await said("Which day?", { answers: ["Friday", "Monday"] })).toEqual({
    answers: ["Friday", "Monday"],
    kind: "question",
    question: "**Friday**, at ten.",
  });
  // A source that opens nothing is refused; the answer stays its words alone.
  const id = main()?.id ?? "";
  const dead = await asked("And then?", async (r) => {
    expect(
      await callDoor(id, "answer", { sources: ["obs_doesnotexist"] })
    ).toContain("opens nothing");
    t.fake.hear(r, { kind: "words", text: "Done." });
  });
  expect(dead.answer).toEqual({ kind: "reply", words: "Done." });
  // Outside a turn of his words, `answer` is refused; any other agent never has it.
  expect(await callDoor(id, "answer", { why: "x" })).toContain("Not done");
  const other = register(t.desk, {
    brief: "Test brief",
    folder: t.dir,
    runtime: "claude",
  });
  expect(await callDoor(other, "answer", { why: "x" })).toContain(
    "the main session's alone"
  );
});

test("presence registers nothing; a turn launching is never ended by the lost turns' sweep; a busy ask is not kept by its key, and a key with other words is refused", async () => {
  expect(await keepMainSession(t.desk)).toBe(
    "Life's main session opens on your first words."
  );
  expect(main()).toBeFalsy();
  const first = await asked("Hello", (r) =>
    t.fake.hear(r, { kind: "words", text: "Hi." })
  );
  // The sweep runs while the next ask reads its session's state, after its turn is written.
  const { state } = t.fake.runtime;
  t.fake.runtime.state = (async (ref: string) => {
    await endLostTurns(t.desk);
    return await state(ref);
  }) as typeof state;
  const next = askMainSession(
    t.desk,
    { key: "k2", words: "Again" },
    () => undefined
  );
  await Bun.sleep(5);
  t.fake.runtime.state = state;
  expect(openTurn(t.desk.db, main()?.id ?? "")?.ended_at).toBeNull();
  expect(
    await askMainSession(t.desk, { key: "k3", words: "Busy" }, () => undefined)
  ).toMatchObject({ kind: "error" });
  expect(
    await askMainSession(t.desk, { key: "k2", words: "Other" }, () => undefined)
  ).toEqual({ kind: "error", what: "Not done: this key asked other words." });
  t.fake.hear(first.ref, { kind: "words", text: "Again, hi." });
  t.fake.exit(first.ref);
  expect(await next).toEqual({ kind: "reply", words: "Again, hi." });
  // "Busy" was refused before its turn: its key asks again.
  const again = askMainSession(
    t.desk,
    { key: "k3", words: "Busy" },
    () => undefined
  );
  await Bun.sleep(5);
  expect(t.fake.said.at(-1)?.message).toContain('"Busy"');
  t.fake.hear(first.ref, { kind: "words", text: "Ok." });
  t.fake.exit(first.ref);
  expect(await again).toEqual({ kind: "reply", words: "Ok." });
});

test("presence of a stopped main session, or one whose runtime can't run, says why and keeps nothing", async () => {
  await asked("Hello", (r) => t.fake.hear(r, { kind: "words", text: "Hi." }));
  const id = main()?.id ?? "";
  // Its runtime is gone from the desk.
  t.desk.runtimes = {};
  expect(await keepMainSession(t.desk)).toBe(MOVE_REASONS.blocked("claude"));
  t.desk.runtimes = { claude: t.fake.runtime };
  t.desk.db.run("update agent set status = 'stopped' where id = ?", [id]);
  expect(await keepMainSession(t.desk)).toBe("Life's main session is stopped.");
  expect(t.fake.kept).toEqual([]);
});

test("his word never re-points the main session: it takes no other subject", async () => {
  await asked("Hello", (r) => t.fake.hear(r, { kind: "words", text: "Hi." }));
  const agent = main()?.id ?? "";
  const refused = async (agentChange: AgentChange) => {
    const { id } = ask(
      requested("main-re-point", "Test: re-point", clock().toISOString()),
      { agent: DESK_AGENT, agentChange, confidence: "high" },
      "connector",
      "asked in a chat",
      clock().getTime()
    );
    await applyAgentChanges(t.desk);
    return agentChangeOf(t.desk.db, id)?.error;
  };
  const error = "the main agent takes no other subject";
  expect(await refused({ action: "re_point", agent, project: "test-p" })).toBe(
    error
  );
  expect(
    await refused({ action: "re_point", agent, steps: ["obs_00000000a101"] })
  ).toBe(error);
  expect(main()?.project).toBeNull();
});

test("on his words the main session acts through its door: each act's `said` must be his words of this ask; it tells an agent, stops one, asks a card as his and hands a complaint to the caretaker; never on itself; no other agent has its acts", async () => {
  // The connector's waits read the desk's own store (`readDesk`): this test's desk is it.
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(LEDGER, { force: true });
  t.desk.db = openDesk();
  const other = register(t.desk, {
    brief: "Test brief",
    folder: t.dir,
    runtime: "claude",
  });
  const own =
    ownAssignmentOf(t.desk.db, other) ??
    openAssignment(t.desk, other, { openedBy: "owner" });
  const words =
    "Tell the test agent to book the dentist, then stop it. Ask me about Friday. The names keep coming out wrong.";
  const results: Record<string, string> = {};
  const ticking = setInterval(() => {
    applyAgentChanges(t.desk);
    receiveComplaints(t.desk);
  }, 50);
  let answered: unknown;
  try {
    ({ answer: answered } = await asked(words, async (r) => {
      const id = main()?.id ?? "";
      // All in one millisecond (the clock stands still): each act's ask is its own.
      const act = async (name: string, args: unknown) => {
        results[name] = await callDoor(id, name, args);
      };
      results.notHis = await callDoor(id, "tell_agent", {
        agent: other,
        said: "Buy a boat for Ana",
      });
      await act("tell_agent", { agent: other, said: "book the dentist" });
      results.self = await callDoor(id, "change_registered_agent", {
        action: "stop",
        agent: id,
        said: "then stop it",
      });
      await act("change_registered_agent", {
        action: "stop",
        agent: other,
        said: "then stop it",
      });
      results.noSaid = await callDoor(id, "request_decision", card("Friday?"));
      await act("request_decision", {
        ...card("Friday?"),
        said: "Ask me about Friday",
      });
      await act("complain", { said: "The names keep coming out wrong" });
      t.fake.hear(r, { kind: "words", text: "**Done**." });
    }));
  } finally {
    clearInterval(ticking);
  }
  expect(results.notHis).toContain("must be his own words");
  expect(results.self).toContain("never changes itself");
  expect(results.noSaid).toContain("must be his own words");
  expect(results.change_registered_agent).toContain('\\"state\\":\\"done\\"');
  expect(agentOf(t.desk.db, other)?.status).toBe("stopped");
  // His words reach the agent through the spoken-ask intake, as he said them, on its own assignment, never by meaning.
  const told = readLedger().find((a) => a.after.to === own);
  expect(told?.instruction?.quote).toBe("book the dentist");
  await receiveSpokenAsks(t.desk, () => Promise.reject(new Error("unused")));
  expect(readSpokenAsk(t.desk, { id: own }, told?.id ?? "")).toEqual({
    at: told?.instruction?.at ?? "",
    confidence: undefined,
    until: undefined,
    words: "book the dentist",
  });
  // The card is his own (`owner`): his answer wakes no agent.
  expect(decisionsNow().find((d) => d.question === "Friday?")?.asker).toBe(
    OWNER_ASKER
  );
  // The complaint reached the caretaker, on his words alone: no card, no seal.
  expect(results.complain).toContain('\\"reached\\":\\"caretaker\\"');
  const complaint = readLedger().find(isComplaint);
  expect(complaint?.instruction?.quote).toBe("The names keep coming out wrong");
  expect(complaintOf(complaint as never)).toMatchObject({
    card: null,
    ref: "",
    report: false,
  });
  // Its answer is its last act's kind, from what the act wrote, with its words.
  expect(answered).toEqual({
    ask: complaint?.id,
    kind: "fix",
    words: "**Done**.",
  });
  // No other agent has its acts: the caretaker, active now, is refused them.
  const caretaker = agentInRole(t.desk.db, "caretaker")?.id ?? "";
  expect(
    await callDoor(caretaker, "tell_agent", { agent: other, said: "x" })
  ).toContain("the main session's alone");
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
}, 30_000);

test("an answer's kind is its turn's last act: an agent told, a card asked as his", async () => {
  const other = register(t.desk, {
    brief: "Test dentist agent",
    folder: t.dir,
    runtime: "claude",
  });
  if (!ownAssignmentOf(t.desk.db, other)) {
    openAssignment(t.desk, other, { openedBy: "owner" });
  }
  const play =
    (name: string, args: Record<string, unknown>) => async (r: string) => {
      await callDoor(main()?.id ?? "", name, args);
      t.fake.hear(r, { kind: "words", text: "**On it**." });
    };
  const told = await asked(
    "Tell the dentist agent to move my appointment",
    play("tell_agent", { agent: other, said: "move my appointment" })
  );
  expect(told.answer).toEqual({
    agent: "Test dentist agent",
    kind: "agent",
    told: "move my appointment",
    words: "**On it**.",
  });
  const carded = await asked(
    "Ask me later about the dentist bill",
    play("request_decision", {
      ...card("The dentist bill?"),
      said: "Ask me later about the dentist bill",
    })
  );
  expect(carded.answer).toEqual({
    card:
      decisionsNow().find((d) => d.question === "The dentist bill?")?.id ?? "",
    kind: "card",
    words: "**On it**.",
  });
});
