import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { createApp } from "./app";
import {
  locate,
  type Point,
  storeHistory,
  throughOf,
  visitsIn,
  visitsTo,
  whereVisits,
  zonedInstant,
} from "./location";
import { services } from "./services";
import { OWNER_TOKEN, testConfig, testDb } from "./testing";

const MIN = 60_000;
const HOUR = 60 * MIN;
const START = Date.parse("2026-10-01T00:00:00Z");
const METER = 1 / 111_320; // degrees of latitude
const HOME = { latitude: 21.03, longitude: 105.85 };

const fix = (minute: number, meters = 0): Point => ({
  accuracyM: 10,
  from: START + minute * MIN,
  latitude: HOME.latitude + meters * METER,
  longitude: HOME.longitude,
  to: START + minute * MIN,
  visit: false,
});
const visit = (from: number, to: number): Point => ({
  ...fix(from),
  to: START + to * MIN,
  visit: true,
});

test("visits: fixes in a row and iOS visits count, a lone fix or one after a long silence starts anew", () => {
  const points = [
    fix(0),
    fix(5),
    fix(60, 2000), // elsewhere: ends the first visit
    fix(240),
    fix(245),
    fix(500), // over two hours without a point: a new run, and alone it is passing by
    fix(600, 2000),
    visit(700, 900),
    fix(905), // still there after iOS's departure: the same visit
  ];
  const found = visitsIn(points, [{ ...HOME, radiusM: 100 }]).map((r) => [
    (r.from - START) / MIN,
    (r.to - START) / MIN,
  ]);
  expect(found).toEqual([
    [0, 5],
    [240, 245],
    [700, 905],
  ]);
});

test("visits: a fix too coarse for the place says nothing about it", () => {
  const coarse = { ...fix(5, 1000), accuracyM: 1500 };
  const home = [{ ...HOME, radiusM: 50 }];
  expect(visitsIn([fix(0), coarse], home)).toEqual([]);
  expect(visitsIn([fix(0), coarse, fix(10)], home)).toHaveLength(1);
});

test("where: the stay around a time, else the nearest fix within 30 minutes, else before and after", () => {
  const points = [fix(0), fix(5), fix(10), fix(90, 3000), fix(200)];
  const stay = locate(points, START + 7 * MIN);
  expect(stay.kind).toBe("stay");
  const near = locate(points, START + 100 * MIN);
  expect(near.kind === "point" && near.point.from).toBe(START + 90 * MIN);
  const unknown = locate(points, START + 140 * MIN);
  expect(unknown).toEqual({
    after: fix(200),
    before: fix(90, 3000),
    kind: "unknown",
  });
  // Inside an iOS visit, even with no fix for hours.
  const inside = locate([visit(0, 600)], START + 300 * MIN);
  expect(inside.kind).toBe("stay");
});

test("a wall-clock time in a zone, across daylight saving", () => {
  const iso = (local: string, zone: string) =>
    zonedInstant(local, zone).toISOString();
  expect(iso("2026-10-09T14:30", "Asia/Jakarta")).toBe(
    "2026-10-09T07:30:00.000Z"
  );
  expect(iso("2026-03-08T03:30", "America/New_York")).toBe(
    "2026-03-08T07:30:00.000Z"
  );
  expect(iso("2026-03-07T03:30", "America/New_York")).toBe(
    "2026-03-07T08:30:00.000Z"
  );
  expect(iso("2026-10-25T00:00", "Europe/Berlin")).toBe(
    "2026-10-24T22:00:00.000Z"
  );
});

let env: Awaited<ReturnType<typeof testDb>>;
beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
});
afterEach(() => {
  setSystemTime();
});

const auth = {
  Authorization: `Bearer ${OWNER_TOKEN}`,
  "Content-Type": "application/json",
};
const at = (minute: number) => new Date(START + minute * MIN).toISOString();

test("the phone's history is stored once, a visit takes its departure, and a reader reads its stays", async () => {
  const app = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      intelligence: null,
    })
  );
  const post = async (body: object) =>
    (
      await app.request("/location-history", {
        body: JSON.stringify(body),
        headers: auth,
        method: "POST",
      })
    ).json();
  const fixes = [0, 5, 10].map((minute) => ({
    accuracyM: 10,
    ...HOME,
    observedAt: at(minute),
  }));
  const arrived = {
    accuracyM: 30,
    ...HOME,
    arrivedAt: at(300),
    departedAt: null,
  };
  expect(await post({ fixes, visits: [arrived] })).toEqual({
    fixes: 3,
    visits: 1,
  });
  expect(await post({ fixes })).toEqual({ fixes: 0, visits: 0 });
  await post({ visits: [{ ...arrived, departedAt: at(420) }] });

  // The phone names its fixes: that name stands for the place.
  expect(
    await post({
      fixes: [315, 320].map((minute) => ({
        accuracyM: 10,
        ...HOME,
        observedAt: at(minute),
        placeName: "École Home",
      })),
    })
  ).toEqual({ fixes: 2, visits: 0 });

  // A reader's REST reads: stays as data.
  const get = (path: string) => app.request(path, { headers: auth });
  const morning = {
    arrivedAt: at(0),
    latitude: HOME.latitude,
    leftAt: at(10),
    longitude: HOME.longitude,
  };
  const home = {
    ...morning,
    arrivedAt: at(300),
    leftAt: at(420),
    place: "École Home",
  };
  expect(await (await get(`/where?at=${at(320)}`)).json()).toEqual([home]);
  expect(await (await get(`/where?at=${at(200)}`)).json()).toEqual([]);
  // A day is the reader's to bound: only instants cross, never a local date.
  expect((await get("/where?at=2026-10-01")).status).toBe(400);
  expect(
    await (await get(`/visits?from=${at(0)}&to=${at(24 * 60)}`)).json()
  ).toEqual([home, morning]);
  expect(await (await get(`/visits?from=${at(100)}`)).json()).toEqual([home]);
  expect(
    await (await get(`/visits?place=${encodeURIComponent("école")}`)).json()
  ).toEqual([home, morning]);
  const around = `latitude=${HOME.latitude}&longitude=${HOME.longitude}&radiusM=50`;
  expect(await (await get(`/visits?${around}&from=${at(100)}`)).json()).toEqual(
    [home]
  );
  expect((await get("/visits?place=nowhere")).status).toBe(404);
  expect((await get(`/visits?place=home&${around}`)).status).toBe(400);
  expect((await get(`/visits?latitude=${HOME.latitude}`)).status).toBe(400);
});

// A stay under way has no `leftAt`; it gets one when a later point lies outside or the silence passes MAX_GAP_MS.
test("a stay under way has no leftAt, until a point outside or two hours of silence end it", () => {
  const home = (minute: number) => ({
    accuracyM: 10,
    ...HOME,
    observedAt: at(minute),
  });
  const away = { ...home(100), latitude: HOME.latitude + 2000 * METER };
  const range = { from: new Date(START), to: new Date(START + 600 * MIN) };
  const lefts = () =>
    visitsTo(env.db, undefined, range)?.map((v) => v.leftAt) ?? [];
  storeHistory(env.db, { fixes: [home(0), home(5), home(10)], visits: [] });

  setSystemTime(START + 60 * MIN);
  expect(lefts()).toEqual([null]);
  expect(whereVisits(env.db, new Date(START + 7 * MIN))[0]?.leftAt).toBeNull();

  // A later point outside the stay ends it, at its last point.
  storeHistory(env.db, { fixes: [away], visits: [] });
  expect(lefts()).toEqual([at(10)]);

  // Silence past MAX_GAP_MS ends a stay with no point outside.
  env.reset();
  storeHistory(env.db, { fixes: [home(0), home(5), home(10)], visits: [] });
  setSystemTime(START + 10 * MIN + 2 * 60 * MIN);
  expect(lefts()).toEqual([null]);
  setSystemTime(START + 10 * MIN + 2 * 60 * MIN + 1);
  expect(lefts()).toEqual([at(10)]);

  // A window that ended 3 hours ago: the point outside, after its end, is read through now.
  env.reset();
  storeHistory(env.db, {
    fixes: [
      home(0),
      home(5),
      home(10),
      home(100),
      { ...home(170), latitude: HOME.latitude + 2000 * METER },
    ],
    visits: [],
  });
  setSystemTime(START + 180 * MIN);
  expect(
    visitsTo(env.db, undefined, {
      from: new Date(START),
      to: new Date(START + 30 * MIN),
    })?.map((v) => v.leftAt)
  ).toEqual([at(100)]);

  // A single passing fix keeps its leftAt.
  env.reset();
  storeHistory(env.db, { fixes: [home(0)], visits: [] });
  setSystemTime(START + 10 * MIN);
  expect(whereVisits(env.db, new Date(START + 5 * MIN))[0]?.leftAt).toBe(at(0));
});

test("circle mode: a fix too coarse to tell does not end a stay under way", () => {
  const home = (minute: number, accuracyM = 10) => ({
    accuracyM,
    ...HOME,
    observedAt: at(minute),
  });
  storeHistory(env.db, { fixes: [home(0), home(5), home(10)], visits: [] });
  // A 300 m fix, 2 km away: too coarse to tell, so it says nothing either way.
  storeHistory(env.db, {
    fixes: [{ ...home(20, 300), latitude: HOME.latitude + 2000 * METER }],
    visits: [],
  });
  setSystemTime(START + 30 * MIN);
  const found = visitsTo(
    env.db,
    { ...HOME, radiusM: 50 },
    { from: new Date(START), to: new Date(START + 30 * MIN) }
  );
  expect(found?.map((v) => v.leftAt)).toEqual([null]);
});

test("reads go through now only when a stay at the window's end could still be under way", () => {
  const now = START + 1000 * HOUR;
  expect(throughOf(now - 3 * HOUR, now)).toBe(now);
  expect(throughOf(now - 100 * HOUR, now)).toBe(now - 100 * HOUR);
  expect(throughOf(now + HOUR, now)).toBe(now + HOUR);
});
