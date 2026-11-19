import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, DAY } from "../core/clock";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as checks from "../memory/checks";
import { DECISIONS, requestDecision } from "../memory/decisions";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as memoryLock from "../memory/memory-lock";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lifelog from "../sources/lifelog-push";
import {
  PUSHED,
  pushNewCards,
  pushNewCardsIfChanged,
  pushNewDecisionsAtOnce,
} from "./card-push";

const card = (n: number, kind: "decision" | "voice" | "person" = "decision") =>
  ({
    group: kind === "person" ? "guessed person" : kind,
    kind,
    pushId: n.toString(16).padStart(16, "0"),
    question: "Pay Kit's invoice?",
    ref: `dec_${n}`,
    subject: null,
    title: "It is due.",
  }) as checks.InboxCheck;
const cards = (n: number, kind?: "decision" | "voice" | "person") =>
  Array.from({ length: n }, (_, i) => card(i + 1, kind));

let open = cards(0);
let look: ReturnType<typeof spyOn<typeof checks, "checksNow">>;
let push: ReturnType<typeof spyOn<typeof lifelog, "notifyPhone">>;
const clean = () => {
  rmSync(PUSHED, { force: true });
  rmSync(DECISIONS, { force: true });
};
beforeEach(() => {
  clean();
  look = spyOn(checks, "checksNow").mockImplementation(() =>
    Promise.resolve(open)
  );
  push = spyOn(lifelog, "notifyPhone").mockResolvedValue(undefined);
});
afterEach(() => {
  look.mockRestore();
  push.mockRestore();
  clean();
});
const later = (days: number) => new Date(clock().getTime() + days * DAY);

test("the first run pushes nothing and sees every open card; a new one pushes with its id and the badge", async () => {
  open = cards(265);
  await pushNewCards();
  expect(push).not.toHaveBeenCalled();
  open = [...cards(265), card(266)];
  await pushNewCards();
  expect(push.mock.calls).toEqual([
    [
      {
        badge: 266,
        body: "1 new card",
        pushId: card(266).pushId,
        title: "Life",
      },
    ],
  ]);
  await pushNewCards();
  expect(push).toHaveBeenCalledTimes(1);
});

test("several new cards are one push with their count and no card", async () => {
  open = cards(2);
  await pushNewCards();
  open = cards(9);
  await pushNewCards();
  expect(push.mock.calls).toEqual([
    [{ badge: 9, body: "7 new cards", title: "Life" }],
  ]);
});

test("a card that only improves pushes nothing and is not in the badge", async () => {
  open = cards(2);
  await pushNewCards();
  open = [...cards(2), ...cards(9, "person").slice(2)];
  await pushNewCards();
  expect(push).not.toHaveBeenCalled();
});

test("an unnamed voice counts in the badge and never pushes a card", async () => {
  open = cards(2);
  await pushNewCards();
  open = [...cards(2), card(3, "voice")];
  await pushNewCards();
  expect(push.mock.calls).toEqual([[{ badge: 3 }]]);
});

test("an answered card is a badge-only push; nothing changed is none", async () => {
  open = cards(3);
  await pushNewCards();
  open = cards(2);
  await pushNewCards();
  await pushNewCards();
  expect(push.mock.calls).toEqual([[{ badge: 2 }]]);
});

test("a card gone for 31 days is new when it returns", async () => {
  open = cards(2);
  await pushNewCards();
  open = cards(1);
  await pushNewCards(later(31));
  open = cards(2);
  await pushNewCards(later(32));
  expect(push.mock.calls.at(-1)?.[0]).toMatchObject({
    body: "1 new card",
    pushId: card(2).pushId,
  });
});

test("what goes out holds no ref, title or question", async () => {
  open = cards(1);
  await pushNewCards();
  open = cards(2);
  await pushNewCards();
  const sent = JSON.stringify(push.mock.calls);
  for (const secret of ["dec_", "Pay Kit", "It is due", "planner"]) {
    expect(sent).not.toContain(secret);
  }
});

const ask = () =>
  requestDecision("planner", {
    deadline: later(2).toISOString(),
    options: [
      { id: "yes", label: "Pay Kit" },
      { id: "no", label: "Wait" },
    ],
    question: "Pay Kit's invoice?",
    title: "It is due.",
  });
let held: ReturnType<typeof spyOn<typeof memoryLock, "isLocked">>;
beforeEach(() => {
  held = spyOn(memoryLock, "isLocked").mockReturnValue(false);
});
afterEach(() => {
  held.mockRestore();
});
/** The watcher's state is the process's: a look while a run holds the lock notes the decisions it saw. */
const forget = async () => {
  held.mockReturnValue(true);
  await pushNewCardsIfChanged();
  held.mockReturnValue(false);
};

test("the watcher's minute reads the inbox (`checksNow` decides whether to read it again), never while a run holds the lock", async () => {
  await forget();
  await pushNewCardsIfChanged();
  held.mockReturnValue(true);
  await pushNewCardsIfChanged();
  expect(look).toHaveBeenCalledTimes(1);
  held.mockReturnValue(false);
  await pushNewCardsIfChanged();
  expect(look).toHaveBeenCalledTimes(2);
});

test("while a run holds the lock a new decision still pushes, from its own lines and without a look", async () => {
  open = cards(2);
  await pushNewCards();
  await forget();
  held.mockReturnValue(true);
  const { id } = await ask();
  await pushNewCardsIfChanged();
  expect(look).toHaveBeenCalledTimes(1);
  expect(push.mock.calls).toEqual([
    [
      {
        badge: 3,
        body: "1 new card",
        pushId: checks.pushIdOf(id),
        title: "Life",
      },
    ],
  ]);
  // The lock is released with the decision open: the full look finds it seen, and pushes nothing more.
  open = [
    ...cards(2),
    { group: "decision", kind: "decision", pushId: checks.pushIdOf(id) },
  ] as checks.InboxCheck[];
  held.mockReturnValue(false);
  await pushNewCardsIfChanged();
  expect(push).toHaveBeenCalledTimes(1);
});

test("a new decision pushes on the seconds' look, once", async () => {
  open = cards(1);
  await pushNewCardsIfChanged();
  open = cards(2);
  await requestDecision("owner", {
    deadline: later(1).toISOString(),
    options: [
      { id: "yes", label: "Send it" },
      { id: "no", label: "Not now" },
    ],
    question: "Send Kit the quote?",
    title: "He asked for it.",
  });
  pushNewDecisionsAtOnce();
  await Bun.sleep(0);
  expect(push).toHaveBeenCalledTimes(1);
  pushNewDecisionsAtOnce();
  await Bun.sleep(0);
  expect(push).toHaveBeenCalledTimes(1);
});
