import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createApp } from "./app";
import { locate, type Point, visitsIn, zonedInstant } from "./location";
import { services } from "./services";
import { OWNER_TOKEN, testConfig, testDb } from "./testing";

const MIN = 60_000;
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
  expect(await (await get("/where?at=2026-10-01")).json()).toEqual([
    morning,
    home,
  ]);
  expect(
    await (await get(`/visits?place=${encodeURIComponent("école")}`)).json()
  ).toEqual([home, morning]);
  const around = `latitude=${HOME.latitude}&longitude=${HOME.longitude}&radiusM=50`;
  expect(await (await get(`/visits?${around}&from=${at(100)}`)).json()).toEqual(
    [home]
  );
  expect((await get("/visits?place=nowhere")).status).toBe(404);
  expect((await get(`/visits?place=home&${around}`)).status).toBe(400);
  expect((await get("/visits")).status).toBe(400);
});
