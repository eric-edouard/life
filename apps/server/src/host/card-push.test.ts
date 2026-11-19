import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, DAY } from "../core/clock";
import { setSettings } from "../core/settings";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as checks from "../memory/checks";
import { DECISIONS, requestDecision } from "../memory/decisions";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as memoryLock from "../memory/memory-lock";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lifelog from "../sources/lifelog-push";
import {
  levelOf,
  pushNewCards,
  pushNewCardsIfChanged,
  pushNewDecisionsAtOnce,
  SEEN,
} from "./card-push";

const later = (days: number) => new Date(clock().getTime() + days * DAY);
const card = (n: number, kind: "decision" | "voice" | "person" = "decision") =>
  ({
    deadline: kind === "decision" ? later(2).toISOString() : null,
    draft: null,
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
const alone = (n: number, kind?: "decision" | "voice" | "person") => ({
  body: "1 new card",
  level: "active" as const,
  pushId: card(n, kind).pushId,
  title: "Life",
});

let open = cards(0);
let look: ReturnType<typeof spyOn<typeof checks, "checksNow">>;
let push: ReturnType<typeof spyOn<typeof lifelog, "notifyPhone">>;
const clean = () => {
  rmSync(SEEN, { force: true });
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
test("the first run pushes nothing and sees every open card; a new one pushes with its id and the badge", async () => {
  open = cards(265);
  await pushNewCards();
  expect(push).not.toHaveBeenCalled();
  open = [...cards(265), card(266)];
  await pushNewCards();
  expect(push.mock.calls).toEqual([[{ badge: 266, ...alone(266) }]]);
  await pushNewCards();
  expect(push).toHaveBeenCalledTimes(1);
});

test("every new decision pushes alone, with its id", async () => {
  open = cards(2);
  await pushNewCards();
  open = cards(9);
  await pushNewCards();
  expect(push.mock.calls.map(([p]) => p)).toEqual(
    [3, 4, 5, 6, 7, 8, 9].map((n) => ({ badge: 9, ...alone(n) }))
  );
});

test("Life's own checks push too: the first 5 alone, the rest as one push that names no card", async () => {
  open = cards(2);
  await pushNewCards();
  open = [...cards(2), ...cards(10, "person").slice(2)];
  await pushNewCards();
  expect(push.mock.calls.map(([p]) => p)).toEqual([
    ...[3, 4, 5, 6, 7].map((n) => ({ badge: 2, ...alone(n, "person") })),
    { badge: 2, body: "3 more new cards", level: "active", title: "Life" },
  ]);
});

test("an unnamed voice pushes alone and counts in the badge", async () => {
  open = cards(2);
  await pushNewCards();
  open = [...cards(2), card(3, "voice")];
  await pushNewCards();
  expect(push.mock.calls).toEqual([[{ badge: 3, ...alone(3, "voice") }]]);
});

test("his notification settings: off pushes nothing, quiet is passive, urgent is time-sensitive within 3 hours", async () => {
  setSettings({ notifications: { "guessed person": "quiet", voice: "off" } });
  try {
    open = cards(1);
    await pushNewCards();
    const soon = { ...card(2), deadline: later(0.1).toISOString() };
    const drafted = { ...card(3), draft: { text: "Hi" } } as checks.InboxCheck;
    open = [...cards(1), soon, drafted, card(4, "voice"), card(5, "person")];
    await pushNewCards();
    expect(push.mock.calls).toEqual([
      [{ badge: 4, ...alone(2), level: "time-sensitive" }],
      [{ badge: 4, ...alone(3) }],
      [{ badge: 4, ...alone(5, "person"), level: "passive" }],
    ]);
  } finally {
    setSettings({ notifications: null });
  }
});

test("a level: quiet is passive; urgent is time-sensitive with no deadline or within 3 hours, else active", () => {
  const now = clock();
  const at = (hours: number) =>
    new Date(now.getTime() + hours * 3_600_000).toISOString();
  expect(levelOf("quiet", null, now)).toBe("passive");
  expect(levelOf("normal", at(1), now)).toBe("active");
  expect(levelOf("urgent", null, now)).toBe("time-sensitive");
  expect(levelOf("urgent", at(3), now)).toBe("time-sensitive");
  expect(levelOf("urgent", at(3.01), now)).toBe("active");
  expect(levelOf("urgent", at(-1), now)).toBe("time-sensitive");
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
        level: "active",
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
