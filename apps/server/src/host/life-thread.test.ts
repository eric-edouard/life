import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { appendJsonl } from "../core/files";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { rateDecision } from "../memory/decision-after-answer";
import { recordDelivered } from "../memory/decision-delivery";
import { DECISIONS } from "../memory/decision-lines";
import { answerDecision, requestDecision } from "../memory/decisions";
import { CORRECTIONS } from "../memory/memory-files";
import { Correction } from "../records/observation";
import { expectWire } from "./http/wire-fixture";
import { itemStateOf, readThread } from "./life-thread";

// Made-up asks, answers and cards throughout.

const spies: ReturnType<typeof spyOn>[] = [];
let db: Database;
beforeEach(async () => {
  rmSync(DECISIONS, { force: true });
  setSettings({ desk: { defaultRuntime: "claude", runtimes: { claude: {} } } });
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  mkdirSync(dirname(DESK_STORE), { recursive: true });
  // Only the tables the thread reads, as the desk's store has them.
  db = new Database(DESK_STORE, { create: true, strict: true });
  db.run(
    "create table thread_entry (id integer primary key, ask_key text unique, asked_at text not null, words text, screen text, turn_id integer, answer text, error text, refs text not null default '[]', reactions text not null default '[]', answered_at text, deleted_at text, follows integer)"
  );
  db.run(
    "create table handed_work (entry_id integer, assignment_id text, kind text, handed_at text)"
  );
  db.run(
    "create table event (assignment_id text, event_id text, name text, payload text, received_at text, handed integer default 0, consumed_at text, dropped_at text)"
  );
  db.run(
    "create table turn (assignment_id text, started_at text, ended_at text)"
  );
  spies.push(
    spyOn(await import("./inbox"), "openChecksNow").mockResolvedValue([]),
    spyOn(await import("../memory/who"), "readPeople").mockResolvedValue(
      {} as never
    ),
    spyOn(
      await import("../memory/matters"),
      "readMatterBook"
    ).mockResolvedValue([])
  );
});
afterEach(() => {
  db.close();
  for (const s of spies.splice(0)) {
    s.mockRestore();
  }
  setSettings({ desk: null });
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(DECISIONS, { force: true });
});

const entry = (words: string, refs: string[]) =>
  db.run(
    "insert into thread_entry (asked_at, words, answer, refs, answered_at) values (?, ?, 'An answer.', ?, ?)",
    [
      new Date(Date.now() - 60_000).toISOString(),
      words,
      JSON.stringify(refs),
      new Date().toISOString(),
    ]
  );

test("a thread item's one state: open needs him unless his Later holds it; answered runs, waits on someone or is settled; withdrawn or lapsed is outdated", () => {
  expect(itemStateOf({ isOpen: true, running: false })).toBe("needs_you");
  expect(
    itemStateOf({
      isOpen: true,
      later: "2026-11-19T09:00:00.000Z",
      running: false,
    })
  ).toBe("later");
  const answered = { state: "answered" as const };
  expect(
    itemStateOf({ decision: answered, isOpen: false, running: true })
  ).toBe("under_way");
  expect(
    itemStateOf({
      decision: answered,
      isOpen: false,
      matterStatus: "waiting_on_someone",
      running: false,
    })
  ).toBe("waiting_on_someone");
  expect(
    itemStateOf({ decision: answered, isOpen: false, running: false })
  ).toBe("settled");
  expect(
    itemStateOf({
      decision: { state: "withdrawn" },
      isOpen: false,
      running: false,
    })
  ).toBe("outdated");
});

test("an entry whose answer cites what he deleted is hidden; a blanked entry is gone; the rest show, oldest first", async () => {
  entry("What did Kit say?", ["obs_000000000001"]);
  entry("When is the dentist?", ["obs_000000000002"]);
  db.run(
    "insert into thread_entry (asked_at, words, deleted_at) values (?, null, ?)",
    [new Date().toISOString(), new Date().toISOString()]
  );
  spies.push(
    spyOn(
      await import("../memory/memory-files"),
      "deletionsNow"
    ).mockReturnValue({ refs: new Set(["obs_000000000001"]) } as never)
  );
  const page = (await readThread()) as {
    earlier: string | null;
    items: { kind: string; words?: string }[];
    version: string;
  };
  expect(page.items.map((i) => i.words)).toEqual(["When is the dentist?"]);
  expect(page.earlier).toBeNull();
  expectWire("read_thread", { ...page, version: "fixed" }, true);
  expect(await readThread({ ifNot: page.version })).toMatchObject({
    unchanged: true,
  });
});

test("an agent's late reply is an entry of its own that follows his ask", async () => {
  entry("How is the boiler going?", []);
  db.run(
    "insert into thread_entry (asked_at, answer, answered_at, follows) values (?1, 'The plumber comes Thursday.', ?1, 1)",
    [new Date(Date.now() - 30_000).toISOString()]
  );
  const page = (await readThread()) as {
    items: { follows?: number | null; words?: string | null }[];
  };
  expect(page.items.map((i) => [i.words, i.follows])).toEqual([
    ["How is the boiler going?", null],
    [null, 1],
  ]);
  expectWire("read_thread_late_reply", { ...page, version: "fixed" }, true);
});

test("an entry carries its handed work (kind, estimate, whether it runs) and both sides' reactions", async () => {
  entry("Find me a plumber", []);
  const at = new Date(Date.now() - 50_000).toISOString();
  db.run("update thread_entry set reactions = ? where id = 1", [
    JSON.stringify([
      { at, by: "life", with: "👀" },
      { at, by: "owner", with: "👍" },
    ]),
  ]);
  db.run(
    "insert into handed_work (entry_id, assignment_id, kind, handed_at) values (1, 'asg_a', 'research', ?), (1, 'asg_b', 'reply', ?)",
    [at, at]
  );
  // The reply's agent finished its first turn after the hand-over; the research is still going.
  db.run(
    "insert into turn (assignment_id, started_at, ended_at) values ('asg_b', ?, ?)",
    [new Date(Date.now() - 40_000).toISOString(), new Date().toISOString()]
  );
  const page = (await readThread()) as {
    items: { handed: { kind: string; state: string }[] }[];
  };
  expect(page.items[0]?.handed.map((h) => [h.kind, h.state])).toEqual([
    ["research", "under_way"],
    ["reply", "settled"],
  ]);
  expectWire("read_thread_handed", { ...page, version: "fixed" }, true);
});

test("an entry his deletion names is hidden at read, before the desk blanks it", async () => {
  entry("Where is the spare key?", []);
  appendJsonl(CORRECTIONS, Correction, [
    {
      at: new Date().toISOString(),
      cuts: [],
      kind: "deleted",
      oldHashes: [],
      refs: ["thread:1"],
      said: "0123456789abcdef",
      schemaVersion: 1,
      shown: [],
      withSources: false,
    },
  ]);
  try {
    const page = await readThread();
    expect("items" in page && page.items).toEqual([]);
  } finally {
    rmSync(CORRECTIONS, { force: true });
  }
});

test("How am I doing? shows on the first card he answered in the app that day, with his mark", async () => {
  const now = new Date(Date.now() - 3_600_000);
  const { id } = await requestDecision(
    "desk",
    {
      agent: "agt_0123456789ab",
      ask: "Pick a day for the plumber",
      context: "A made-up reason to ask.",
      deadline: new Date(Date.now() + 2 * 86_400_000).toISOString(),
      follow: [],
      onSilence: null,
      options: [
        { id: "tue", label: "Tuesday" },
        { id: "wed", label: "Wednesday" },
      ],
      question: "Which day suits you?",
      recommended: "tue",
      title: "Book the plumber",
    },
    now
  );
  recordDelivered(id, { rules: ["good moment"], verdict: "deliver" }, now);
  await answerDecision(id, ["tue"], undefined, { now, via: "connector" });
  rateDecision(id, "good", now);
  const page = (await readThread()) as {
    items: { card: { rate?: unknown }; ref?: string }[];
  };
  expect(page.items.find((i) => i.ref === id)?.card.rate).toEqual({
    mark: "good",
  });
});
