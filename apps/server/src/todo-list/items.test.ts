import { expect, test } from "bun:test";
import type { LedgerEntry } from "../records/ledger-entry";
import type { SourceEvent } from "../records/source";
import { type Candidate, linked, openItems, owed, pickCompared } from "./items";

const DATE = "2026-10-19";
const item = (over: Partial<Candidate>): Candidate => ({
  at: "2026-10-18T10:00:00.000Z",
  id: "obs_000000000001",
  kind: "to_do",
  line: "-",
  when: DATE,
  ...over,
});
const ids = (
  cs: Candidate[],
  o: Partial<Parameters<typeof openItems>[1]> = {}
) => openItems(cs, { date: DATE, ...o }).map((i) => i.id);

const msg = (over: Partial<SourceEvent>): SourceEvent => ({
  at: "2026-10-17T18:41:00.000Z",
  chat: "+33600000001",
  fromMe: false,
  id: "imessage:A",
  sender: "+33600000001",
  source: "imessage",
  text: "Two prices: 108 or 132, which one?",
  ...over,
});

// audit-5-reply-owed: the glazier sent two prices and waited for his choice; nothing reminded him for 43 h. The last
// word in a 1:1 chat he writes in is theirs: a reply he owes, the day after and once more 3 days after.
test("audit-5-reply-owed: a 1:1 chat whose last word is theirs is a reply he owes, shown twice", () => {
  const thread = [
    msg({
      at: "2026-10-14T09:45:00.000Z",
      fromMe: true,
      id: "imessage:0",
      text: "Price and lead time for 5 mm?",
    }),
    msg({}),
    // A bare system line after it is no word of theirs or his.
    msg({ at: "2026-10-17T19:00:00.000Z", id: "imessage:B", text: " " }),
  ];
  const oneToOne = (e: SourceEvent) => !e.chat.startsWith("group");
  expect(owed(thread, oneToOne).map((e) => e.id)).toEqual(["imessage:A"]);
  // Not owed: his own last word, a chat he never wrote in, a group.
  expect(
    owed([...thread, msg({ fromMe: true, id: "imessage:C" })], oneToOne)
  ).toEqual([]);
  expect(owed([msg({})], oneToOne)).toEqual([]);
  // His photo after their words is his answer; their photo alone is a word of theirs.
  const photo = {
    files: [{ mime: "image/jpeg", ref: "f1" }],
    text: "",
  } as Partial<SourceEvent>;
  expect(
    owed(
      [...thread, msg({ ...photo, fromMe: true, id: "imessage:P" })],
      oneToOne
    )
  ).toEqual([]);
  expect(
    owed([...thread, msg({ ...photo, id: "imessage:Q" })], oneToOne).map(
      (e) => e.id
    )
  ).toEqual(["imessage:Q"]);
  const group = thread.map((e) => ({ ...e, chat: "group-1" }));
  expect(owed(group, oneToOne)).toEqual([]);
  const reply = item({
    id: "imessage:A",
    kind: "reply",
    said: "2026-10-17",
    when: undefined,
  });
  const on = (date: string) => openItems([reply], { date }).length;
  // Tomorrow's `read_day`, read today, lists no reply: it shows only as its days come.
  expect(
    openItems([reply], { date: "2026-10-18", today: "2026-10-17" })
  ).toEqual([]);
  expect(
    ["2026-10-17", "2026-10-18", "2026-10-19", "2026-10-20", "2026-10-21"].map(
      on
    )
  ).toEqual([0, 1, 0, 1, 0]);
});

test("a dated item shows on its day, then late only while a daily review has not shown it twice", () => {
  const late = item({ when: "2026-10-16" });
  expect(ids([late])).toEqual(["obs_000000000001"]);
  expect(openItems([late], { date: DATE })[0]?.overdue).toBe(true);
  const shown = (...days: string[]) => new Map([["obs_000000000001", days]]);
  expect(ids([late], { shown: shown("2026-10-16", "2026-10-17") })).toEqual([]);
  // Only days it could be in Due count (from the one before its day): its id in older answers is not a showing.
  expect(ids([late], { shown: shown("2026-10-10", "2026-10-16") })).toEqual([
    "obs_000000000001",
  ]);
  // Late, it shows only on days that have come: tomorrow's read lists it not (no double showing).
  expect(ids([late], { date: "2026-10-20", today: DATE })).toEqual([]);
  // On its day it shows whatever was shown before (the day before, from tomorrow's read).
  expect(ids([item({})], { shown: shown("2026-10-18") })).toEqual([
    "obs_000000000001",
  ]);
  // Waiting: its day only. With neither its day nor the day it was said: never.
  expect(
    ids([
      item({ kind: "waiting_on_someone", when: "2026-10-18" }),
      item({ id: "obs_000000000002", when: undefined }),
    ])
  ).toEqual([]);
});

test("copies merge: a reminder into its observation, an item said in an open task's turn is that task's", () => {
  const said = item({ ref: "job:8@x" });
  const reminder = item({
    id: "entry_0000000000r1",
    kind: "reminder",
    obs: "obs_000000000001",
    urgent: true,
    when: undefined,
  });
  const [one, ...rest] = openItems([said, reminder], { date: DATE });
  expect(rest).toEqual([]);
  expect(one).toMatchObject({
    id: "obs_000000000001",
    merged: ["entry_0000000000r1"],
    urgent: true,
  });
  expect(ids([said], { tasks: new Set(["job:8@x"]) })).toEqual([]);
  // A reminder with a due date gives an undated observation its day: shown on it, not lost.
  const undated = item({ said: "2026-10-15", when: undefined });
  expect(ids([undated, { ...reminder, when: DATE }])).toEqual([
    "obs_000000000001",
  ]);
});

test("rank: his urgent flag and priority, then who owes whom, his goals in order, closeness, age", () => {
  const cs = [
    item({
      at: "2026-10-01T00:00:00.000Z",
      id: "waiting",
      kind: "waiting_on_someone",
    }),
    item({ at: "2026-10-02T00:00:00.000Z", id: "todo-old" }),
    item({ id: "todo-goal2", projects: ["shop"] }),
    item({ id: "todo-goal1", projects: ["life"] }),
    item({ id: "todo-inner", person: "person:ann" }),
    item({ id: "promise", kind: "promise" }),
    item({ id: "high", priority: "high" }),
    item({ id: "urgent", urgent: true }),
  ];
  expect(
    ids(cs, {
      goals: [["life"], ["shop"]],
      levels: new Map([["person:ann", 0]]),
    })
  ).toEqual([
    "urgent",
    "high",
    "promise",
    "todo-goal1",
    "todo-goal2",
    "todo-inner",
    "todo-old",
    "waiting",
  ]);
});

test("an undated to-do or promise: the day after it was said and 3 days after, as those days come; then stale, never due", () => {
  const undated = item({
    kind: "promise",
    said: "2026-10-18",
    when: undefined,
  });
  const days = [
    "2026-10-18",
    "2026-10-19",
    "2026-10-20",
    "2026-10-21",
    "2026-10-22",
    "2026-10-28",
  ];
  expect(days.map((date) => openItems([undated], { date }).length)).toEqual([
    0, 1, 0, 1, 0, 0,
  ]);
  // Read a day ahead (the review reads tomorrow), it is not shown early, and never overdue.
  expect(
    openItems([undated], { date: "2026-10-19", today: "2026-10-18" })
  ).toEqual([]);
  expect(openItems([undated], { date: "2026-10-19" })[0]?.overdue).toBe(false);
});

const action = (over: Partial<LedgerEntry>): LedgerEntry => ({
  after: {},
  at: "2026-10-15T10:00:00.000Z",
  id: "entry_0123456789ab",
  kind: "add",
  result: "ok",
  schemaVersion: 1,
  target: "reminder:12",
  via: "session",
  why: "he asked",
  ...over,
});

// life#242 step 1: Life's record keeps what only Life writes (section, recurrence, subtasks), never compared.
test("the fold keeps section, recurrence and every subtask written; 'clear' stops a recurrence; inbound compares none", () => {
  const add = action({
    after: {
      list: "Travel",
      recurrence: "weekly mon",
      section: "Visa",
      subtasks: [{ title: "Photos" }],
      title: "Renew visa",
    },
  });
  const more = action({
    after: { subtasks: [{ title: "Form" }] },
    at: "2026-10-15T11:00:00.000Z",
    id: "entry_0123456789ac",
    kind: "edit",
  });
  const stop = action({
    after: { recurrence: "clear" },
    at: "2026-10-15T12:00:00.000Z",
    id: "entry_0123456789ad",
    kind: "edit",
  });
  const kept = linked([add, more]).get("reminder:12")?.fields;
  expect(kept).toMatchObject({
    recurrence: "weekly mon",
    section: "Visa",
    subtasks: [{ title: "Photos" }, { title: "Form" }],
  });
  expect(
    linked([add, more, stop]).get("reminder:12")?.fields.recurrence
  ).toBeNull();
  expect(
    pickCompared({
      recurrence: { frequency: "daily" },
      section: "Visa",
      subtasks: [],
      title: "x",
    })
  ).toEqual({ title: "x" });
});
