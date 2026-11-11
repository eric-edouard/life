import { afterAll, expect, test } from "bun:test";
import { sources, timelineSpans } from "@lifelog/db/schema";
import { testDb } from "./testing";
import { recorded } from "./timeline-spans";

const env = testDb();
afterAll(() => {
  env.drop();
});

const BASE = 1_790_000_000_000;
const at = (s: number) => new Date(BASE + s * 1000);

test("recorded: whether a Pendant's audio falls in a range, and since when lifelog can tell", () => {
  const asked = (from: number, to: number) =>
    recorded(env.db, at(from), at(to));
  expect(asked(0, 100)).toEqual({ hasRecording: false, since: null });
  const span = (sourceId: string, firstPage: number, [a, b]: number[]) => ({
    endAt: at(b ?? 0),
    facts: { audible: [], breaks: [], pauses: [], speech: [], unanalyzed: [] },
    firstPage,
    sourceId,
    startAt: at(a ?? 0),
  });
  env.db
    .insert(sources)
    .values([{ id: "pendant" }, { id: "import:old" }])
    .run();
  env.db
    .insert(timelineSpans)
    .values([
      // A long span the later, shorter ones start inside: the answer must not rest on the latest start alone.
      span("pendant", 0, [100, 400]),
      span("pendant", 1, [150, 160]),
      // An old-app recording is no Pendant's: it neither counts nor moves `since`.
      span("import:old", 0, [-900, -500]),
    ])
    .run();
  const since = at(100).toISOString();
  expect(asked(-1000, -400)).toEqual({ hasRecording: false, since });
  expect(asked(0, 100)).toEqual({ hasRecording: false, since });
  expect(asked(50, 150)).toEqual({ hasRecording: true, since });
  expect(asked(300, 500)).toEqual({ hasRecording: true, since });
  expect(asked(400, 500)).toEqual({ hasRecording: false, since });
});
