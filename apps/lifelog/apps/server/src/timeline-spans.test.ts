import { afterAll, expect, test } from "bun:test";
import { sources, timelineSpans } from "@lifelog/db/schema";
import { createApp } from "./app";
import { services } from "./services";
import { OWNER_TOKEN, testConfig, testDb } from "./testing";
import { recorded } from "./timeline-spans";

const env = testDb();
afterAll(() => {
  env.drop();
});

const BASE = 1_790_000_000_000;
const at = (s: number) => new Date(BASE + s * 1000);
const iso = (s: number) => at(s).toISOString();
const DAY = 86_400;

test("recorded: a Pendant's stretches over a range, pauses under a minute joined, and since when lifelog can tell", async () => {
  const asked = (from: number, to: number) =>
    recorded(env.db, at(from), at(to));
  expect(asked(0, 100)).toEqual({ since: null, stretches: [] });
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
      // A long span the shorter one starts inside, then one 30 s after it: one stretch.
      span("pendant", 0, [100, 400]),
      span("pendant", 1, [150, 160]),
      span("pendant", 2, [430, 500]),
      // Five minutes later: a second stretch.
      span("pendant", 3, [800, 900]),
      // An old-app recording is no Pendant's: it neither counts nor moves `since`.
      span("import:old", 0, [-900, -500]),
    ])
    .run();
  const since = iso(100);
  const first = { endAt: iso(500), startAt: iso(100) };
  const second = { endAt: iso(900), startAt: iso(800) };
  expect(asked(-1000, -400)).toEqual({ since, stretches: [] });
  expect(asked(0, 100)).toEqual({ since, stretches: [] });
  expect(asked(0, 2000)).toEqual({ since, stretches: [first, second] });
  // A range that starts inside a long span finds it, whole; one that ends before the next stretch leaves it out.
  expect(asked(300, 420)).toEqual({
    since,
    stretches: [{ endAt: iso(400), startAt: iso(100) }],
  });
  expect(asked(900, 2000)).toEqual({ since, stretches: [] });

  const app = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      intelligence: null,
      search: null,
    })
  );
  const get = (from: number, to: number) =>
    app.request(`/recorded?from=${iso(from)}&to=${iso(to)}`, {
      headers: { Authorization: `Bearer ${OWNER_TOKEN}` },
    });
  expect(await (await get(700, 2000)).json()).toEqual({
    since,
    stretches: [second],
  });
  expect((await get(0, 32 * DAY)).status).toBe(400);
});
