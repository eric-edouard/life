import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
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
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as matters from "../memory/matters";
import { LEDGER, readLedger } from "../memory/memory-files";
import { readToldLife } from "../memory/told-life";
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
import { askedOf, callDoorOf, setup } from "./test-desk";
import { endLostTurns } from "./turn-ends";

// The main session (Ask Life, slice 1): registered on his first words, one desk turn per ask on a session the runtime
// keeps, its lines heard as they come, its answer the words after its last tool call; one ask at a time, a retry under
// its key asks once, never woken by the clock, every door tool refused on its turn. Made-up words.

let t = setup();
beforeEach(() => {
  t = setup();
  t.desk.runtimes = { pi: t.fake.runtime };
  setSettings({ desk: { runtimes: {} } });
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

const asked = (words: string, play: (ref: string) => unknown, key?: string) =>
  askedOf(t, words, play, key);
/** A reply as the phone gets it: its Markdown, no acts or refs unless given. */
const reply = (text: string, more: Record<string, unknown> = {}) => ({
  acts: [],
  entry: expect.any(Number),
  kind: "reply" as const,
  refs: [],
  text,
  ...more,
});

test("his first words register the main session and start its session from its brief and his words; the answer is its text after its last tool call; the turn ends replied with its tokens and its billed cost", async () => {
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
  expect(answer).toEqual(reply("In the drawer, by your notes."));
  expect(lines.map((l) => l.kind)).toEqual(["words", "step", "words", "words"]);
  expect(lines[1]).toEqual({
    kind: "step",
    verb: "Opening",
    what: "what Life holds",
  });
  const a = main();
  expect(a).toMatchObject({ role: "main", session: ref, status: "active" });
  expect(t.fake.said[0]?.message).toStartWith(MAIN_BRIEF);
  expect(t.fake.said[0]?.message).toContain(
    'His words, through Ask Life: "Where is my passport?"'
  );
  await Bun.sleep(0);
  expect(turnsOf(a?.id ?? "")).toEqual([
    { cause: "main_ask", ended_at: expect.any(String), outcome: "replied" },
  ]);
  expect(
    t.desk.db.query("select tokens_out, cost_usd from turn").get()
  ).toEqual({
    cost_usd: 0.002,
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
      'His words, through Ask Life: "And this one?"\nOn his screen (refs; `fetch` opens one): {"open":"matter:mat_x","tab":"inbox"}\nHanded work takes about: booking 10 min, lookup 60 s, other 3 min, redraft 30 s, reply 60 s, research 5 min.',
    ref: first.ref,
  });
  t.fake.hear(first.ref, { kind: "words", text: "It waits on Ana." });
  t.fake.exit(first.ref);
  expect(await next).toEqual(reply("It waits on Ana."));
  expect(agentInRole(t.desk.db, "main")?.id).toBe(main()?.id);
});

test("an ask while one runs waits its turn, Life's eyes on it at once; a retry under its key replays its lines and ends with the same answer, asking once", async () => {
  const lines: MainSessionLine[] = [];
  const first = askMainSession(t.desk, { key: "k1", words: "One" }, (l) =>
    lines.push(l)
  );
  await Bun.sleep(5);
  const ref = t.fake.said[0]?.ref ?? "";
  t.fake.hear(ref, { kind: "words", text: "Yes." });
  const queued: MainSessionLine[] = [];
  const second = askMainSession(t.desk, { words: "Two" }, (l) =>
    queued.push(l)
  );
  expect(queued).toEqual([{ kind: "reaction", with: "👀" }]);
  const replayed: MainSessionLine[] = [];
  const retry = askMainSession(t.desk, { key: "k1", words: "One" }, (l) =>
    replayed.push(l)
  );
  t.fake.hear(ref, { kind: "words", text: " Done." });
  t.fake.exit(ref);
  expect(await first).toEqual(reply("Yes. Done."));
  expect(await retry).toEqual(reply("Yes. Done."));
  expect(replayed).toEqual(lines);
  // After a restart (a new handle on the store: nothing kept in memory), the key gets its stored answer, never asked
  // again; other words under it are refused.
  const restarted = { ...t.desk, db: openDesk(t.desk.db.filename) };
  expect(
    await askMainSession(
      restarted,
      { key: "k1", words: "One" },
      () => undefined
    )
  ).toEqual(reply("Yes. Done."));
  expect(
    await askMainSession(
      restarted,
      { key: "k1", words: "Uno" },
      () => undefined
    )
  ).toEqual({ kind: "error", what: "Not done: this key asked other words." });
  // The second runs once the first ended, on the same session.
  for (let i = 0; i < 20 && t.fake.said.length < 2; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: a poll
    await Bun.sleep(5);
  }
  expect(t.fake.said[1]?.message).toContain('"Two"');
  t.fake.hear(ref, { kind: "words", text: "Two it is." });
  t.fake.exit(ref);
  expect(await second).toEqual(reply("Two it is."));
  expect(
    t.desk.db
      .query<{ answer: string; reactions: string; words: string }, []>(
        "select words, answer, reactions from thread_entry order by id"
      )
      .all()
      .map((e) => ({
        ...e,
        reactions: (
          JSON.parse(e.reactions) as { by: string; with: string }[]
        ).map((r) => `${r.by} ${r.with}`),
      }))
  ).toEqual([
    { answer: "Yes. Done.", reactions: [], words: "One" },
    { answer: "Two it is.", reactions: ["life 👀"], words: "Two" },
  ]);
});

test("an ask its session would not take keeps no retry key: the retry asks again; the main session holds no wait", async () => {
  await asked("Hello", (r) => t.fake.hear(r, { kind: "words", text: "Hi." }));
  const { talk } = t.fake.runtime;
  t.fake.runtime.talk = () =>
    Promise.reject(new SessionLive("session is running"));
  expect(
    await askMainSession(t.desk, { key: "k", words: "Again" }, () => undefined)
  ).toMatchObject({
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
  expect(await again).toEqual(reply("Hi again."));
  const a = main();
  const s = a && currentAssignmentOf(t.desk.db, a.id);
  expect(a && s && agentWaitOf(a, s)).toBeNull();
});

test("a failed run answers an error and ends its turn failed; a run with no words answers that it gave none", async () => {
  const { answer } = await asked("Hello", (r) =>
    t.fake.hear(r, { kind: "thinking" })
  );
  expect(answer).toMatchObject({ kind: "error", what: "Life gave no answer." });
  const failing = askMainSession(t.desk, { words: "Again" }, () => undefined);
  await Bun.sleep(5);
  t.fake.exit(t.fake.said[1]?.ref ?? "", false, { why: "rate_limit" });
  expect(await failing).toMatchObject({ kind: "error", what: "rate_limit" });
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
  // Words go alone: never with a reaction or a Stop.
  expect((await post({ stop: true, words: "Hi" })).status).toBe(400);
  expect(
    (await post({ react: { entry: 1, with: "👍" }, words: "Hi" })).status
  ).toBe(400);
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
    { answer: reply("Hello."), kind: "answer" },
  ]);
  expect(await (await post({})).json()).toEqual({ done: true });
  expect(t.fake.kept).toEqual([ref]);
  // His reaction is kept on the entry and starts no turn; Stop with nothing running says so.
  expect(await (await post({ react: { entry: 1, with: "❤️" } })).json()).toEqual(
    { done: true }
  );
  expect(
    t.desk.db.query("select reactions from thread_entry where id = 1").get()
  ).toEqual({ reactions: expect.stringContaining('"by":"owner","with":"❤️"') });
  expect(t.fake.said).toHaveLength(1);
  expect(await (await post({ stop: true })).json()).toEqual({
    done: false,
    why: "Life is not answering anything now.",
  });
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

const callDoor = (id: string, name: string, args: unknown) =>
  callDoorOf(t, id, name, args);

test("presence registers nothing; a turn launching is never ended by the lost turns' sweep; a key with other words is refused", async () => {
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
    await askMainSession(t.desk, { key: "k2", words: "Other" }, () => undefined)
  ).toEqual({ kind: "error", what: "Not done: this key asked other words." });
  t.fake.hear(first.ref, { kind: "words", text: "Again, hi." });
  t.fake.exit(first.ref);
  expect(await next).toEqual(reply("Again, hi."));
});

test("presence of a stopped main session, or one whose runtime can't run, says why and keeps nothing", async () => {
  await asked("Hello", (r) => t.fake.hear(r, { kind: "words", text: "Hi." }));
  const id = main()?.id ?? "";
  // Its runtime is gone from the desk.
  t.desk.runtimes = {};
  expect(await keepMainSession(t.desk)).toBe(MOVE_REASONS.blocked("pi"));
  t.desk.runtimes = { pi: t.fake.runtime };
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
    runtime: "pi",
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
      results.mac = await callDoor(id, "change_registered_agent", {
        action: "continue_on_mac",
        agent: other,
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
  expect(results.mac).toContain("only his app");
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
  // The complaint reached the caretaker, on his words alone: no card.
  expect(results.complain).toContain('\\"reached\\":\\"caretaker\\"');
  const complaint = readLedger().find(isComplaint);
  expect(complaint?.instruction?.quote).toBe("The names keep coming out wrong");
  expect(complaintOf(complaint as never)).toMatchObject({
    card: null,
    ref: "",
    report: false,
  });
  // Its answer carries its acts, from what each act wrote, with its words.
  expect(answered).toEqual(
    reply("**Done**.", {
      acts: [
        { agent: "Test brief", kind: "agent", told: "book the dentist" },
        { agent: "Test brief", kind: "agent", told: "then stop it" },
        { card: expect.any(String), kind: "card" },
        { kind: "fix" },
      ],
    })
  );
  // No other agent has its acts: the caretaker, active now, is refused them.
  const caretaker = agentInRole(t.desk.db, "caretaker")?.id ?? "";
  expect(
    await callDoor(caretaker, "tell_agent", { agent: other, said: "x" })
  ).toContain("the main session's alone");
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
}, 30_000);

test("an answer carries its turn's acts: an agent told (handed work, Life's eyes on his words), a card asked as his, a matter marked", async () => {
  const other = register(t.desk, {
    brief: "Test dentist agent",
    folder: t.dir,
    runtime: "pi",
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
  expect(told.answer).toEqual(
    reply("**On it**.", {
      acts: [
        {
          agent: "Test dentist agent",
          kind: "agent",
          told: "move my appointment",
        },
      ],
    })
  );
  expect(told.lines).toContainEqual({ kind: "reaction", with: "👀" });
  expect(t.desk.db.query("select kind from handed_work").all()).toEqual([
    { kind: "other" },
  ]);
  const carded = await asked(
    "Ask me later about the dentist bill",
    play("request_decision", {
      ...card("The dentist bill?"),
      said: "Ask me later about the dentist bill",
    })
  );
  expect(carded.answer).toEqual(
    reply("**On it**.", {
      acts: [
        {
          card:
            decisionsNow().find((d) => d.question === "The dentist bill?")
              ?.id ?? "",
          kind: "card",
        },
      ],
    })
  );
  // life#1103: a matter marked by his word answers `done` with its matter.
  const matter = {
    id: "matter_aaaaaaaaaaaa",
    name: "Mend the test boiler",
    open: true,
    steps: [
      {
        at: "2026-11-10T10:00:00.000Z",
        day: "2026-11-10",
        kind: "promise",
        quote: "it",
        ref: "obs_000000000001",
        text: "it",
      },
    ],
  };
  const book = spyOn(matters, "readMatterBook").mockResolvedValue([
    matter,
  ] as never);
  try {
    const marked = await asked(
      "Mark the boiler as important",
      play("correct_memory", {
        correction: {
          important: true,
          kind: "matter-important",
          matter: matter.id,
        },
        said: "Mark the boiler as important",
      })
    );
    expect(marked.answer).toEqual(
      reply("**On it**.", { acts: [{ kind: "done", matter: matter.id }] })
    );
  } finally {
    book.mockRestore();
  }
});

// life#1103: an agent holding several matters gets his words on the one he means.
test("`tell_agent` on an assignment the agent holds open puts his words there; one it does not hold is refused", async () => {
  const other = register(t.desk, {
    brief: "Test agent of two matters",
    folder: t.dir,
    runtime: "pi",
  });
  openAssignment(t.desk, other, { openedBy: "owner", steps: ["obs_test_one"] });
  const second = openAssignment(t.desk, other, {
    openedBy: "owner",
    steps: ["obs_test_two"],
  });
  const results: string[] = [];
  await asked(
    "Tell it to call the second test garage, and call the first test garage",
    async (r) => {
      const id = main()?.id ?? "";
      results.push(
        await callDoor(id, "tell_agent", {
          agent: other,
          said: "call the second test garage",
          to: second,
        }),
        await callDoor(id, "tell_agent", {
          agent: other,
          said: "call the second test garage",
          to: "asg_not_its_own",
        }),
        // life#1146: the same words to its own assignment, named or not, are told once.
        await callDoor(id, "tell_agent", {
          agent: other,
          said: "call the first test garage",
          to: ownAssignmentOf(t.desk.db, other),
        }),
        await callDoor(id, "tell_agent", {
          agent: other,
          said: "call the first test garage",
        })
      );
      t.fake.hear(r, { kind: "words", text: "**On it**." });
    }
  );
  expect(results[0]).toContain(`\\"assignment\\":\\"${second}\\"`);
  expect(
    readLedger().find((a) => a.after.to === second)?.instruction?.quote
  ).toBe("call the second test garage");
  expect(results[1]).toContain("is not an open assignment of");
  expect(
    readLedger().filter(
      (a) => a.instruction?.quote === "call the first test garage"
    )
  ).toHaveLength(1);
});

test("Ask Life has everything (his rulings of 22 Nov 2026): his to-do list, an appointment, what he tells Life and his directory, each only on his words of this ask, through the connector's own writers", async () => {
  const results: Record<string, string> = {};
  const since = clock();
  await asked(
    "Remember that the test boiler is fixed. Add a project Home under the area nowhere.",
    async (r) => {
      const id = main()?.id ?? "";
      const call = async (key: string, name: string, args: unknown) => {
        results[key] = await callDoor(id, name, args);
      };
      await call("todoNotHis", "change_todo_item", {
        kind: "add",
        said: "Buy a boat for Ana",
        title: "Boat",
      });
      await call("aptNotHis", "change_appointment", {
        action: "remove",
        appointment: "apt_0123456789ab",
        said: "Buy a boat for Ana",
      });
      await call("apt", "change_appointment", {
        action: "remove",
        appointment: "apt_0123456789ab",
        said: "Remember that the test boiler is fixed",
      });
      await call("toldNotHis", "tell_life", { said: "Buy a boat for Ana" });
      await call("told", "tell_life", {
        said: "the test boiler is fixed",
      });
      await call("dirNotHis", "change_directory_entry", {
        action: "add",
        kind: "area",
        name: "Boats",
        said: "Buy a boat for Ana",
      });
      // Checked on a copy first, as the connector's: refused, nothing changed.
      await call("dir", "change_directory_entry", {
        action: "add",
        area: "nowhere",
        kind: "project",
        name: "Home",
        said: "Add a project Home under the area nowhere",
      });
      t.fake.hear(r, { kind: "words", text: "**Done**." });
    }
  );
  for (const key of ["todoNotHis", "aptNotHis", "toldNotHis", "dirNotHis"]) {
    expect(results[key]).toContain("must be his own words");
  }
  expect(results.apt).toContain('\\"result\\":\\"failed\\"');
  expect(results.told).toContain("Kept");
  expect(readToldLife(since).map((e) => e.text)).toContain(
    "the test boiler is fixed"
  );
  expect(results.dir).toContain("unknown area nowhere");
  // No other agent has them.
  const other = register(t.desk, {
    brief: "Test brief",
    folder: t.dir,
    runtime: "pi",
  });
  if (!ownAssignmentOf(t.desk.db, other)) {
    openAssignment(t.desk, other, { openedBy: "owner" });
  }
  expect(
    await callDoor(other, "tell_life", { said: "the test boiler is fixed" })
  ).toContain("the main session's alone");
});
