import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  conversations,
  ownerEdits,
  sources,
  timelineSpans,
} from "@lifelog/db/schema";
import { asc } from "drizzle-orm";
import {
  anchorId,
  anchorOf,
  groupSource,
  markDirty,
  PIECES_BEFORE,
  saveEdit,
} from "./grouping";
import { testDb } from "./testing";

// Pieces made under the old rules (before PIECES_BEFORE) keep their ids; the one rule applies after.
const SOURCE = "pendant-1";
const BASE = PIECES_BEFORE;
const at = (s: number) => BASE + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();

let env: ReturnType<typeof testDb>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});

const live = () =>
  env.db
    .select()
    .from(conversations)
    .orderBy(asc(conversations.captureStartedAt))
    .all()
    .filter((c) => c.retiredAt === null)
    .map((c) => anchorOf(c.id));

// Two closed conversations 60 seconds apart from `start` seconds past BASE, then one wide dirty
// range over both, as a late PUT inside the span marks it.
const pair = (start: number) => {
  env.db.insert(sources).values({ id: SOURCE }).run();
  const speech = [
    [start, start + 60],
    [start + 120, start + 180],
  ] as const;
  env.db
    .insert(timelineSpans)
    .values({
      endAt: new Date(at(start + 300)),
      facts: {
        audible: [],
        breaks: [],
        pauses: [],
        speech: speech.map(([a, b]) => [iso(a), iso(b)] as [string, string]),
        unanalyzed: [],
      },
      firstPage: 0,
      sourceId: SOURCE,
      startAt: new Date(at(start)),
    })
    .run();
  env.db
    .insert(conversations)
    .values(
      speech.map(([a, b]) => ({
        captureEndedAt: new Date(at(b)),
        captureStartedAt: new Date(at(a)),
        closedAt: new Date(at(b + 400)),
        id: anchorId(at(a)),
        sourceId: SOURCE,
      }))
    )
    .run();
  markDirty(env.db, [SOURCE], [at(start), at(start + 300)]);
  groupSource(env.db, SOURCE);
};
const OLD = -10_000;

test("old pieces keep their ids when one wide dirty range regroups them", () => {
  pair(OLD);
  expect(live()).toEqual([at(OLD), at(OLD + 120)]);
});

test("the same pair after the instant is one conversation", () => {
  pair(60);
  expect(live()).toEqual([at(60)]);
});

test("his merge joins the old pair", () => {
  pair(OLD);
  saveEdit(env.db, {
    editedAt: iso(0),
    from: iso(OLD + 30),
    id: randomUUID(),
    kind: "merge",
    to: iso(OLD + 150),
  });
  groupSource(env.db, SOURCE);
  expect(live()).toEqual([at(OLD)]);
});

test("a stored AI split still cuts", () => {
  pair(60);
  env.db
    .insert(ownerEdits)
    .values({
      at: new Date(at(100)),
      editedAt: new Date(at(100)),
      id: randomUUID(),
      kind: "split",
      source: "ai",
    })
    .run();
  markDirty(env.db, [SOURCE], [at(60), at(360)]);
  groupSource(env.db, SOURCE);
  // Cut at 100: the later group claims the anchor of the conversation it holds.
  expect(live()).toEqual([at(60), at(180)]);
});
