import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { appendJsonl } from "../core/files";
import { DESK_STORE } from "../core/paths";
import { setSettings } from "../core/settings";
import { deleteFromMemoryAndTodoItems } from "../host/deletion-door";
import { quietLineOf } from "../host/desk-read";
import { threadEntriesHolding } from "../host/life-thread";
import {
  INSTRUCTIONS,
  instructionsFor,
  recordInstruction,
} from "../memory/instructions";
import { CORRECTIONS, readCorrections } from "../memory/memory-files";
import { Correction } from "../records/observation";
import { apply, openStore, turnRef, WATCH } from "../sources/lifelog";
import {
  conversation,
  lifelogServer,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { openDesk } from "./desk-store";
import { askedOf, setup } from "./test-desk";
import { blankDeletedThreadEntries } from "./thread-deletions";

// His deletion reaches the Life thread's entries, agents' quiet lines and his instructions (v4.1, bundle J): the preview lists them, the
// record names them, the desk blanks the entries on its tick and an answer never writes back onto one. Made-up words.

const AT = "2026-10-14T09:00:00.000Z";
const JOB = "job-1";
const TURN = turnRef(JOB, 0, AT);

beforeEach(() => {
  setSettings({
    desk: { defaultRuntime: "claude", runtimes: { claude: {} } },
    sources: ["lifelog"],
  });
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
});
afterEach(() => {
  setSettings({ desk: null, sources: [] });
  rmSync(dirname(DESK_STORE), { force: true, recursive: true });
  rmSync(CORRECTIONS, { force: true });
  rmSync(INSTRUCTIONS, { force: true });
  rmSync(WATCH, { force: true, recursive: true });
});

/** A record naming `refs`, as the door writes it. */
const deleted = (refs: string[]) =>
  appendJsonl(CORRECTIONS, Correction, [
    {
      at: new Date().toISOString(),
      cuts: [],
      kind: "deleted",
      oldHashes: [],
      refs,
      said: "0123456789abcdef",
      schemaVersion: 1,
      shown: [],
      withSources: false,
    },
  ]);

test("the door: the preview lists the entries and instructions holding the words; an answer quoting them after the preview leaves the digest as it was; the record names them; the desk's tick blanks the entries", async () => {
  const server = lifelogServer({
    [`/transcription-jobs/${JOB}/transcript`]: () => ({
      turns: [
        { speakerId: "speaker_0", text: "Bring the blue drawings tomorrow." },
      ],
    }),
  });
  const store = openStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c1", { endAt: AT, startAt: AT })],
      turns: [turnFixture(0, AT, null, null)],
    })
  );
  store.db.close();
  const desk = openDesk(DESK_STORE);
  try {
    const entry = (words: string, answer: string, refs: string[] = []) =>
      desk.run(
        "insert into thread_entry (asked_at, words, answer, refs, screen) values (?, ?, ?, ?, '{}')",
        [AT, words, answer, JSON.stringify(refs)]
      );
    entry("What should I bring?", "The blue drawings, tomorrow.");
    entry("What did we say?", "You agreed on a time.", [TURN]);
    entry("Any news?", "Nothing new today.");
    // An agent's quiet line quoting the words (its `doing`), and one that does not.
    const quiet = (id: string, doing: string, rev = "r1") =>
      desk.run(
        "insert or replace into quiet_line (assignment_id, doing, eta, at, rev) values (?, ?, null, ?, ?)",
        [id, doing, AT, rev]
      );
    quiet("asg_quoting", "Fetching the blue drawings");
    quiet("asg_other", "Sorting the photos");
    const quoting = recordInstruction({
      said: "Never ask me about the blue drawings again",
      scope: "all",
      text: "Never ask about the blue drawings.",
    });
    const other = recordInstruction({
      said: "Keep it short",
      scope: "all",
      text: "Keep answers short.",
    });

    const ask = {
      cuts: [{ quote: "blue drawings", ref: TURN }],
      refs: [],
      said: "that goes",
    };
    // The desk off: its copies are found all the same.
    setSettings({ desk: null });
    const preview = await deleteFromMemoryAndTodoItems(ask);
    expect("askAgain" in preview && preview.copies).toEqual([
      { id: "thread:1", kind: "thread entry" },
      { id: "thread:2", kind: "thread entry" },
      { id: "quiet:asg_quoting@r1", kind: "quiet line" },
      { id: quoting.id, kind: "instruction" },
    ]);
    // Ask Life's answer to the preview quotes the words: a new match, which never changes what he confirms.
    entry("Delete the blue drawings", "This would delete the blue drawings.");
    const confirm = "askAgain" in preview ? preview.confirm : "";
    const done = await deleteFromMemoryAndTodoItems({ ...ask, confirm });
    expect("reindexed" in done).toBe(true);
    const line = readCorrections().at(-1);
    expect(line?.kind === "deleted" && line.refs).toEqual([
      "thread:1",
      "thread:2",
      "thread:4",
      "quiet:asg_quoting@r1",
      quoting.id,
    ]);
    // The quiet line is hidden at read at once, then deleted by the tick.
    expect(quietLineOf(desk, "asg_quoting")).toBeUndefined();
    expect(quietLineOf(desk, "asg_other")?.doing).toBe("Sorting the photos");
    // The instruction quoting them is gone at read, its file never rewritten.
    expect(instructionsFor({}).map((i) => i.id)).toEqual([other.id]);

    // The tick blanks them in place, once; the unrelated one stands.
    expect(blankDeletedThreadEntries(desk)).toBe(3);
    expect(blankDeletedThreadEntries(desk)).toBe(0);
    expect(desk.query("select assignment_id from quiet_line").all()).toEqual([
      { assignment_id: "asg_other" },
    ]);
    // A later line on the same work is another line: it shows, and the tick leaves it.
    quiet("asg_quoting", "Sorting the drawings", "r2");
    expect(quietLineOf(desk, "asg_quoting")?.doing).toBe(
      "Sorting the drawings"
    );
    blankDeletedThreadEntries(desk);
    expect(quietLineOf(desk, "asg_quoting")?.doing).toBe(
      "Sorting the drawings"
    );
    expect(
      desk
        .query(
          "select id, words, answer, screen, deleted_at is not null as gone from thread_entry order by id"
        )
        .all()
    ).toEqual([
      { answer: "", gone: 1, id: 1, screen: null, words: "" },
      { answer: "", gone: 1, id: 2, screen: null, words: "" },
      {
        answer: "Nothing new today.",
        gone: 0,
        id: 3,
        screen: "{}",
        words: "Any news?",
      },
      { answer: "", gone: 1, id: 4, screen: null, words: "" },
    ]);
  } finally {
    desk.close();
    server.close();
  }
});

test("an answer arriving after its entry was deleted writes nothing onto it", async () => {
  const t = setup();
  t.desk.runtimes = { pi: t.fake.runtime };
  setSettings({ desk: { runtimes: {} } });
  const { answer } = await askedOf(
    t,
    "Forget what I said about the key",
    (r) => {
      // His deletion, during the turn, names the entry of this very ask.
      deleted(["thread:1"]);
      t.fake.hear(r, {
        kind: "words",
        text: "Done: the spare key is forgotten.",
      });
    }
  );
  expect(answer).toMatchObject({ kind: "reply" });
  expect(
    t.desk.db
      .query(
        "select words, answer, deleted_at is not null as gone from thread_entry"
      )
      .all()
  ).toEqual([{ answer: "", gone: 1, words: "" }]);
});

test("a store the desk has not opened since quiet lines came still gives its entries to the preview", () => {
  const desk = openDesk(DESK_STORE);
  desk.run(
    "insert into thread_entry (asked_at, words, answer, refs) values (?, 'Where are the blue drawings?', 'In the hall.', '[]')",
    [AT]
  );
  desk.run("drop table quiet_line");
  desk.close();
  expect(
    threadEntriesHolding((texts) =>
      texts.some((x) => x?.includes("blue drawings"))
    )
  ).toEqual([{ id: "thread:1", kind: "thread entry" }]);
});
