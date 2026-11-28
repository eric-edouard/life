import { afterEach, expect, setSystemTime, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, HOUR } from "../core/clock";
import { setSettings } from "../core/settings";
import { agentsNow } from "../host/agents-now";
import { openTurn } from "../host/desk-read";
import { projectsWithoutRoomOf, WAITS_FOR_ROOM } from "../host/spending";
import { withdrawAnswer } from "../memory/decision-after-answer";
import { DECISIONS } from "../memory/decision-lines";
import { answerDecision } from "../memory/decisions";
import { INSTRUCTIONS, recordInstruction } from "../memory/instructions";
import { askDecision, register } from "./agent-actions";
import { pollAnswers, wakeDue } from "./desk-clock";
import { deleteUnbegunTurn } from "./desk-store";
import { SPENDING_STOP, spendingStopInTurn } from "./spending-stop";
import { ANA, ahead, callDoorOf, cardFields, on, setup } from "./test-desk";
import { stopWithdrawn } from "./turn-ends";
import { runsIn } from "./turn-usage";

// A one-off project's quiet line and its cost cap (the owner's decisions of 28 Nov 2026, tickets 31 and 32), over a
// fake runtime and made-up projects.

afterEach(() => {
  rmSync(INSTRUCTIONS, { force: true });
  rmSync(DECISIONS, { force: true });
  setSettings({ budget: null });
  setSystemTime();
});

/** His cap on made-up project `project`, as "Build it" records it. */
const cap = (project: string, words: string) =>
  recordInstruction({
    effect: "budget",
    said: `Build it, up to ${words}`,
    scope: `project:${project}`,
    text: `up to ${words}`,
  });

const lineOf = (db: Parameters<typeof agentsNow>[0], id: string) => {
  const a = agentsNow(db, clock().getTime()).find((x) => x.id === id);
  return { doing: a?.doing, eta: a?.eta };
};

test("the quiet line: the door's set_wait and write_notes write it when given `doing` (a new one replaces its eta), keep it when not or when the wait is refused, and the agent's read shows it", async () => {
  const t = setup();
  const id = register(t.desk, {
    brief: "Test: tidy the made-up recipe folder",
    folder: t.dir,
    project: "test-recipes",
    runtime: "fake",
  });
  expect(lineOf(t.desk.db, id)).toEqual({ doing: null, eta: null });
  const eta = ahead(2 * HOUR);
  const wait = { events: [ANA], reason: "the next batch", until: ahead(HOUR) };
  await callDoorOf(t, id, "set_wait", {
    ...wait,
    doing: "Sorting the 2023 recipes",
    eta,
  });
  expect(lineOf(t.desk.db, id)).toEqual({
    doing: "Sorting the 2023 recipes",
    eta,
  });
  // A wait refused (too soon) writes no line.
  await callDoorOf(t, id, "set_wait", {
    ...wait,
    doing: "Refused",
    until: ahead(1000),
  });
  await callDoorOf(t, id, "write_notes", { text: "notes, no line" });
  expect(lineOf(t.desk.db, id).doing).toBe("Sorting the 2023 recipes");
  await callDoorOf(t, id, "write_notes", {
    doing: "Checking the photos",
    text: "notes",
  });
  expect(lineOf(t.desk.db, id)).toEqual({
    doing: "Checking the photos",
    eta: null,
  });
  // The caretaker's work is his complaints: no quiet line, as no notes, on its read.
  const caretaker = register(t.desk, {
    brief: "Test: the caretaker",
    folder: t.dir,
    role: "caretaker",
    runtime: "fake",
    steps: ["obs_000000000001"],
  });
  await callDoorOf(t, caretaker, "write_notes", {
    doing: "Fixing the complaint",
    text: "notes",
  });
  expect(lineOf(t.desk.db, caretaker).doing).toBeNull();
});

test("room: caps add up within the month, oldest first; one that does not fit waits, a smaller later one still fits; no amount, no limit", () => {
  const caps = [
    { at: "2026-11-02T00:00:00.000Z", project: "late", usd: 3 },
    { at: "2026-11-01T00:00:00.000Z", project: "first", usd: 6 },
    { at: "2026-11-01T12:00:00.000Z", project: "big", usd: 5 },
  ];
  expect([...projectsWithoutRoomOf(caps, 10)]).toEqual(["big"]);
  expect([...projectsWithoutRoomOf(caps, undefined)]).toEqual([]);
  // Caps that fit exactly fit, whatever floats say.
  const cents = [
    { at: "2026-11-01T00:00:00.000Z", project: "a", usd: 0.1 },
    { at: "2026-11-02T00:00:00.000Z", project: "b", usd: 0.2 },
  ];
  expect([...projectsWithoutRoomOf(cents, 0.3)]).toEqual([]);
});

/** Made-up project `project`'s agents, each with a running turn on pi; `ended` billed and ended. */
const agentsOn = (
  t: ReturnType<typeof setup>,
  project: string,
  names: string[],
  ended: { usd: number; who: string[] } = { usd: 0, who: [] }
) =>
  names.map((n) => {
    const id = register(t.desk, {
      brief: `Test: the ${n} agent on ${project}`,
      folder: t.dir,
      project,
      runtime: "fake",
    });
    const isEnded = ended.who.includes(n);
    t.desk.db.run(
      "insert into turn (agent_id, assignment_id, cause, started_at, model, tokens_in, cost_usd, search_usd, ended_at) values (?, ?, 'first turn', ?, 'pi:default', ?, ?, 0, ?)",
      [
        id,
        on(t.desk, id).id,
        clock().toISOString(),
        isEnded ? 10 : null,
        isEnded ? ended.usd : null,
        isEnded ? clock().toISOString() : null,
      ]
    );
    return id;
  });

/** Agent `id`'s running turn's run has used `billed` on its models and subagents and `search` on its searches so far. */
const running = (
  t: ReturnType<typeof setup>,
  id: string,
  billed: number,
  search = 0
) => {
  const turn = openTurn(t.desk.db, id)?.id ?? 0;
  runsIn(t.desk.db).set(turn, {
    begun: Promise.resolve(),
    ended: new Promise(() => undefined),
    usage: () => ({
      billedUsd: billed,
      contextFirst: null,
      contextLast: null,
      searchUsd: search,
      tokensCached: 0,
      tokensIn: 1,
      tokensOut: 1,
    }),
  });
};

const budget = (scope: string, words: string) =>
  recordInstruction({
    effect: "budget",
    said: words,
    scope,
    text: words,
  });

const onMatter = (t: ReturnType<typeof setup>, id: string, matter: string) =>
  t.desk.db.run("update assignment set matter_id = ? where id = ?", [
    matter,
    on(t.desk, id).id,
  ]);

/** Agent `id` asks its stop's card, `raises` on its "go" option (`raises` false: a card without it). */
const askStopCard = (t: ReturnType<typeof setup>, id: string, raises = true) =>
  askDecision(t.desk, on(t.desk, id), {
    ...cardFields("go"),
    context:
      "Sorting is taking longer than planned.\n\nSpent so far: 3 dollars.",
    deadline: ahead(24 * HOUR),
    onSilence: null,
    options: [
      {
        id: "go",
        label: "Keep going",
        ...(raises ? { raises: true as const } : {}),
      },
      { icon: "no", id: "stop", label: "Stop here" },
    ],
    question: "Keep going on the sorting?",
    title: "Keep going?",
  });

/** His answer to card `id` (`via` his app or a session), heard by the desk's poll (its cursor set before). */
async function answered(
  t: ReturnType<typeof setup>,
  id: string,
  via?: "connector"
) {
  setSystemTime(new Date(clock().getTime() + 1000));
  await answerDecision(id, ["go"], undefined, via ? { via } : {});
  setSystemTime(new Date(clock().getTime() + 1000));
  pollAnswers(t.desk);
}

test("a capped project's stop counts all its agents' billed work, a running run's models, subagents and searches too; with no cap each assignment keeps the default", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const [, second = ""] = agentsOn(t, "test-bakery", ["first", "second"], {
    usd: 1.5,
    who: ["first"],
  });
  // No cap: 2% of 100 is 2, over the second's own work alone.
  running(t, second, 1.6, 0.3);
  expect(await spendingStopInTurn(t.desk, second)).toBeNull();
  cap("test-bakery", "3 dollars");
  // A matter's own budget above the cap stops nothing before the cap.
  budget("matter:matter_aaaaaaaaaaaa", "up to 50 dollars");
  onMatter(t, second, "matter_aaaaaaaaaaaa");
  expect(await spendingStopInTurn(t.desk, second)).toContain(
    "billed 3.40 dollars, past its spending stop of 3.00"
  );
});

test("a reminded turn counts its stored first run and its running second run once each", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const [id = ""] = agentsOn(t, "test-shed", ["only"]);
  t.desk.db.run(
    "update turn set tokens_in = 10, cost_usd = 1.2, reminded_at = ? where agent_id = ?",
    [clock().toISOString(), id]
  );
  running(t, id, 0.7);
  expect(await spendingStopInTurn(t.desk, id)).toBeNull();
  running(t, id, 0.9);
  expect(await spendingStopInTurn(t.desk, id)).toContain(
    "billed 2.10 dollars, past its spending stop of 2.00"
  );
});

test("a matter's budget is its own latest, over a general one; one lower than its project's cap stops it at the lower", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const [id = ""] = agentsOn(t, "test-kiosk", ["only"]);
  cap("test-kiosk", "30 dollars");
  onMatter(t, id, "matter_bbbbbbbbbbbb");
  budget("matter:matter_bbbbbbbbbbbb", "up to 1 dollar");
  setSystemTime(new Date(clock().getTime() + 1000));
  budget("all", "up to 20 dollars");
  running(t, id, 0.5);
  expect(await spendingStopInTurn(t.desk, id)).toBeNull();
  running(t, id, 1.2);
  expect(await spendingStopInTurn(t.desk, id)).toContain(
    "past its spending stop of 1.00"
  );
});

test("one stop per project: the turn that reaches it asks, a sibling ends asking nothing, an answer to another card frees nothing; only his own raise on the stop's card gives one more", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const [a = "", b = ""] = agentsOn(t, "test-mural", ["a", "b"]);
  cap("test-mural", "3 dollars");
  pollAnswers(t.desk);
  running(t, a, 1.6);
  running(t, b, 1.6);
  expect(await spendingStopInTurn(t.desk, a)).toContain("stop of 3.00");
  // The same turn asking again holds the same stop.
  expect(await spendingStopInTurn(t.desk, a)).toContain("stop of 3.00");
  expect(await spendingStopInTurn(t.desk, b)).toContain("ask no card");
  // `raises` is only for the card a stop asks for.
  await expect(askStopCard(t, b)).rejects.toThrow("spending stop");
  // b's own card, answered: the project's stop stays where it was.
  const other = await askStopCard(t, b, false);
  await answered(t, other.id, "connector");
  expect(await spendingStopInTurn(t.desk, b)).toContain("ask no card");
  const card = await askStopCard(t, a);
  await answered(t, card.id, "connector");
  // One more stop, for both: 6 dollars.
  expect(await spendingStopInTurn(t.desk, b)).toBeNull();
  running(t, b, 4.5);
  expect(await spendingStopInTurn(t.desk, b)).toContain("stop of 6.00");
});

test("his Undo of a raise takes it back", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const [a = ""] = agentsOn(t, "test-cellar", ["a"]);
  cap("test-cellar", "3 dollars");
  pollAnswers(t.desk);
  running(t, a, 3.1);
  await spendingStopInTurn(t.desk, a);
  const card = await askStopCard(t, a);
  await answered(t, card.id, "connector");
  const raised = () =>
    t.desk.db.query("select raised from spending_stop").all();
  expect(raised()).toEqual([{ raised: 1 }]);
  withdrawAnswer(card.id);
  await stopWithdrawn(t.desk);
  expect(raised()).toEqual([{ raised: 0 }]);
});

test("his Stop here, or a raise picked anywhere but his own app, stops the work: nothing asks again until his word", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const [a = ""] = agentsOn(t, "test-attic", ["a"]);
  cap("test-attic", "3 dollars");
  pollAnswers(t.desk);
  running(t, a, 3.1);
  expect(await spendingStopInTurn(t.desk, a)).toContain("stop of 3.00");
  const card = await askStopCard(t, a);
  // A session's pick of `raises` is recorded, and raises nothing.
  await answered(t, card.id);
  expect(await spendingStopInTurn(t.desk, a)).toContain("waits for his word");
  expect(t.desk.db.query("select raised from spending_stop").all()).toEqual([
    { raised: 0 },
  ]);
});

test("a stop whose turn ended without its card, or whose card lapsed, is asked again by the next turn; a deleted unbegun turn lets go of it", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const [a = "", b = ""] = agentsOn(t, "test-roof", ["a", "b"]);
  cap("test-roof", "3 dollars");
  pollAnswers(t.desk);
  running(t, a, 3.1);
  expect(await spendingStopInTurn(t.desk, a)).toContain("stop of 3.00");
  t.desk.db.run("update turn set ended_at = ? where agent_id = ?", [
    clock().toISOString(),
    a,
  ]);
  expect(await spendingStopInTurn(t.desk, b)).toContain("stop of 3.00");
  // b's turn never began: deleted, it holds nothing, and a new turn of a asks.
  const bTurn = openTurn(t.desk.db, b)?.id ?? 0;
  t.desk.db.run("update turn set begun_at = null where id = ?", [bTurn]);
  deleteUnbegunTurn(t.desk.db, bTurn);
  expect(t.desk.db.query("select turn_id from spending_stop").all()).toEqual([
    { turn_id: null },
  ]);
  t.desk.db.run(
    "insert into turn (agent_id, assignment_id, cause, started_at, model) values (?, ?, 'deadline', ?, 'pi:default')",
    [a, on(t.desk, a).id, clock().toISOString()]
  );
  expect(await spendingStopInTurn(t.desk, a)).toContain("stop of 3.00");
  const card = await askStopCard(t, a);
  // His card lapses: the stop is open again, with no card, for the next turn to ask.
  setSystemTime(new Date(clock().getTime() + 25 * HOUR));
  pollAnswers(t.desk);
  expect(
    t.desk.db.query("select decision_id, turn_id from spending_stop").all()
  ).toEqual([{ decision_id: null, turn_id: null }]);
  expect(card.id).toBeTruthy();
});

test("two siblings due in one tick: one turn asks at the project's stop, the other is not woken", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 100 } });
  const [a = "", b = ""] = agentsOn(t, "test-porch", ["a", "b"], {
    usd: 1.6,
    who: ["a", "b"],
  });
  cap("test-porch", "3 dollars");
  for (const id of [a, b]) {
    t.desk.db.run("update assignment set wait_until = ? where id = ?", [
      clock().toISOString(),
      on(t.desk, id).id,
    ]);
  }
  await wakeDue(t.desk);
  const causes = [...t.turns(a), ...t.turns(b)].map((x) => x.cause);
  expect(causes.filter((c) => c === SPENDING_STOP)).toHaveLength(1);
  expect(causes).toHaveLength(3);
});

test("a project whose cap does not fit in the month waits, its quiet line saying so; the one before it starts", async () => {
  const t = setup();
  setSettings({ budget: { monthlyUsd: 10 } });
  const [first, second] = ["test-garden", "test-party"].map((project) =>
    register(t.desk, {
      brief: `Test: ${project}`,
      folder: t.dir,
      project,
      runtime: "fake",
    })
  );
  cap("test-garden", "8 dollars");
  setSystemTime(new Date(clock().getTime() + 1000));
  cap("test-party", "5 dollars");
  await wakeDue(t.desk);
  expect(t.turns(first ?? "")).toHaveLength(1);
  expect(t.turns(second ?? "")).toEqual([]);
  expect(lineOf(t.desk.db, second ?? "")).toEqual({
    doing: WAITS_FOR_ROOM,
    eta: null,
  });
});
