import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { clock, DAY } from "../core/clock";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as checks from "../memory/checks";
import { recordDelivered } from "../memory/decision-delivery";
import { DECISIONS } from "../memory/decision-lines";
import { requestDecision } from "../memory/decisions";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as memoryLock from "../memory/memory-lock";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lifelog from "../sources/lifelog-push";
import {
  pushLevelOf,
  pushNewCards,
  pushNewCardsIfChanged,
  pushNewDecisionsAtOnce,
  SEEN,
} from "./card-push";

const later = (days: number) => new Date(clock().getTime() + days * DAY);
const card = (
  n: number,
  kind: "decision" | "voice" | "person" | "name" = "decision"
) =>
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
const cards = (n: number, kind?: "decision" | "voice" | "person" | "name") =>
  Array.from({ length: n }, (_, i) => card(i + 1, kind));
const alone = (n: number) => ({
  body: "1 new card",
  level: "active" as const,
  pushId: card(n).pushId,
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
  push = spyOn(lifelog, "notifyPhone").mockResolvedValue(true);
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

test("Life's own checks push nothing: a new one moves only the badge", async () => {
  open = cards(2);
  await pushNewCards();
  // A name with no person blocks; a voice to name never does (his yes of 26 Nov 2026): neither pushes.
  open = [
    ...cards(2),
    ...cards(10, "person").slice(2),
    card(11, "name"),
    card(12, "voice"),
  ];
  await pushNewCards();
  expect(push.mock.calls).toEqual([[{ badge: 3 }]]);
});

test("a voice card whose question changes (a new suggested person, a grown group) is not pushed again; its old notification is removed (life#1011)", async () => {
  const asked = (ref: string) => ({
    ...card(1, "voice"),
    pushId: lifelog.pushIdOf(ref),
    ref,
  });
  open = [asked("voice:g1~0a1b2c3d")];
  await pushNewCards();
  open = [asked("voice:g1~0a1b2c3d"), asked("voice:g2~0a1b2c3d")];
  await pushNewCards();
  const before = push.mock.calls.length;
  open = [asked("voice:g1~0a1b2c3d~person:kit"), asked("voice:g2~4e5f6a7b")];
  await pushNewCards();
  expect(push.mock.calls.slice(before)).toEqual([
    [
      {
        removed: [
          lifelog.pushIdOf("voice:g1~0a1b2c3d"),
          lifelog.pushIdOf("voice:g2~0a1b2c3d"),
        ],
      },
    ],
  ]);
});

test("a delivered card's push: time-sensitive within 3 hours of its deadline, else lowered by quiet, raised by interrupt", () => {
  const now = clock();
  const at = (hours: number) => ({
    deadline: new Date(now.getTime() + hours * 3_600_000).toISOString(),
  });
  expect(pushLevelOf(at(2), ["quiet"], now)).toBe("time-sensitive");
  expect(pushLevelOf(at(5), [], now)).toBe("active");
  expect(pushLevelOf(at(5), ["quiet", "interrupt"], now)).toBe("passive");
  expect(pushLevelOf(at(5), ["interrupt"], now)).toBe("time-sensitive");
  expect(pushLevelOf({ deadline: null }, [], now)).toBe("active");
});

test("a card that left the inbox (answered, withdrawn, lapsed) is a badge-only push and its removal; nothing changed is none", async () => {
  open = cards(3);
  await pushNewCards();
  open = cards(2);
  await pushNewCards();
  await pushNewCards();
  expect(push.mock.calls).toEqual([
    [{ removed: [card(3).pushId] }],
    [{ badge: 2 }],
  ]);
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
    context: "A made-up reason to ask.",
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
        pushId: lifelog.pushIdOf(id),
        title: "Life",
      },
    ],
  ]);
  // The lock is released with the decision open: the full look finds it seen, and pushes nothing more.
  open = [
    ...cards(2),
    { group: "decision", kind: "decision", pushId: lifelog.pushIdOf(id) },
  ] as checks.InboxCheck[];
  held.mockReturnValue(false);
  await pushNewCardsIfChanged();
  expect(push).toHaveBeenCalledTimes(1);
});

test("a look while a run holds the lock removes nothing and keeps what the last whole look saw open", async () => {
  open = cards(3);
  await pushNewCardsIfChanged();
  held.mockReturnValue(true);
  await ask();
  await pushNewCardsIfChanged();
  expect(push.mock.calls.flat()).not.toContainEqual(
    expect.objectContaining({ removed: expect.anything() })
  );
  held.mockReturnValue(false);
  open = cards(2);
  await pushNewCardsIfChanged();
  expect(push.mock.calls).toContainEqual([{ removed: [card(3).pushId] }]);
});

test("a new decision pushes on the seconds' look, once", async () => {
  open = cards(1);
  await pushNewCardsIfChanged();
  open = cards(2);
  await requestDecision("owner", {
    context: "A made-up reason to ask.",
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

test("an agent's card pushes once the gate delivered it, never before, and never when delivered silent", async () => {
  open = cards(1);
  await pushNewCards();
  const asked = (n: number) =>
    requestDecision("desk", {
      agent: "agt_1",
      ask: `Pay invoice ${n}`,
      context: "A made-up reason to ask.",
      deadline: later(2).toISOString(),
      follow: [],
      options: [
        { id: "yes", label: "Pay it" },
        { id: "no", label: "Wait" },
      ],
      question: `Pay invoice ${n}?`,
      recommended: "yes",
      title: "It is due.",
    });
  const [a, b] = [await asked(1), await asked(2)];
  const shown = (id: string) =>
    ({
      ...card(9),
      pushId: lifelog.pushIdOf(id),
      ref: id,
    }) as checks.InboxCheck;
  open = [...cards(1), shown(a.id), shown(b.id)];
  await pushNewCards();
  expect(push).not.toHaveBeenCalled();
  recordDelivered(a.id, { verdict: "deliver" });
  recordDelivered(b.id, { silent: true, verdict: "deliver" });
  await pushNewCards();
  expect(push.mock.calls.map(([p]) => p.pushId)).toEqual([
    lifelog.pushIdOf(a.id),
  ]);
});
