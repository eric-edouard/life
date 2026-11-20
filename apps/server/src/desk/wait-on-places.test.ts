import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, HOUR, iso, MIN } from "../core/clock";
import { queuedEvents } from "../host/desk-read";
import { paymentsChannelOf, placesChannelOf } from "../host/event-channels";
import type { EventFilter } from "../records/registered-agent";
import type { Stay } from "../sources/lifelog";
import { register, setWait } from "./agent-actions";
import { readPeopleOnce, wakeDue } from "./desk-clock";
import { pollChannels } from "./event-queue";
import { advance, ahead, asgOf, on, setup } from "./test-desk";

// An agent's wait on the places channel: a made-up arrival near the place it names wakes it once, and a wake hands its
// time and coordinates, never the place's name.

const SITE = { latitude: 10.5, longitude: 20.5 };
/** Degrees of latitude in one meter. */
const METER = 1 / 111_320;
const UNREAD = /places could not be read since \S+: lifelog: down/;

afterEach(() => {
  setSystemTime();
});

/** A stay under way that began now, `north` meters north of the site. */
const stay = (north = 0, over: Partial<Stay> = {}): Stay => ({
  arrivedAt: clock().toISOString(),
  latitude: SITE.latitude + north * METER,
  leftAt: null,
  longitude: SITE.longitude,
  place: "Test Site",
  ...over,
});

/** A desk whose lifelog holds `list` (failing with `lifelog.why`), and an agent after its first turn waiting on `filters`. */
async function waitingOn(...filters: Partial<EventFilter>[]) {
  const s = setup();
  const list: Stay[] = [];
  const lifelog: { why: string } = { why: "" };
  s.desk.channels = [
    placesChannelOf(() =>
      lifelog.why
        ? Promise.reject(new Error(lifelog.why))
        : Promise.resolve(list)
    ),
    paymentsChannelOf(() => ({ between: () => Promise.resolve([]) })),
  ];
  const id = register(s.desk, {
    brief: "Test brief: start when he reaches the site",
    folder: s.dir,
    runtime: "fake",
  });
  await wakeDue(s.desk);
  const rewait = (...events: Partial<EventFilter>[]) =>
    setWait(s.desk, on(s.desk, id), {
      events,
      reason: "an arrival",
      until: ahead(HOUR),
    });
  const set = await rewait(...filters);
  await s.end(id);
  advance(MIN);
  const poll = async () => {
    advance(MIN);
    await pollChannels(s.desk, readPeopleOnce());
  };
  const queued = () => queuedEvents(s.desk.db, asgOf(s.desk, id));
  return { ...s, id, lifelog, list, poll, queued, rewait, set };
}

test("a wait on a place is woken once by an arrival inside 100 m, never by one 400 m away", async () => {
  const { list, poll, queued, set } = await waitingOn({
    channels: ["places"],
    ...SITE,
  });
  expect(set).not.toHaveProperty("error");
  list.push(stay(40), stay(400, { arrivedAt: ahead(-30_000) }));
  await poll();
  await poll();
  expect(queued().map((e) => [e.name, e.event_id])).toEqual([
    ["stay.arrived", `places:${list[0]?.arrivedAt}/arrived`],
  ]);
});

test("a stay that began before the look-back is no arrival, however often it is read", async () => {
  const { list, poll, queued } = await waitingOn({ channels: ["places"] });
  list.push(stay(0, { arrivedAt: iso(clock().getTime() - 49 * HOUR) }));
  await poll();
  await poll();
  expect(queued()).toEqual([]);
});

test("a pattern matches the arrival's line, with the place's name", async () => {
  const { list, poll, queued } = await waitingOn({
    channels: ["places"],
    text_matches: "^arrived test site$",
  });
  list.push(stay(0), stay(0, { arrivedAt: ahead(-30_000), place: null }));
  await poll();
  expect(queued().map((e) => e.event_id)).toEqual([
    `places:${list[0]?.arrivedAt}/arrived`,
  ]);
});

test("a wake hands an arrival's time and coordinates, never the place's name", async () => {
  const { list, poll, queued } = await waitingOn({ channels: ["places"] });
  list.push(stay(0));
  await poll();
  const [row] = queued();
  const facts = JSON.parse(row?.payload ?? "{}");
  expect(Object.keys(facts).sort()).toEqual([
    "arrivedAt",
    "at",
    "id",
    "latitude",
    "longitude",
    "source",
    "what",
  ]);
  expect(row?.payload).not.toContain("Test Site");
});

test("a filter with no channels is never woken by an arrival", async () => {
  const { list, poll, queued } = await waitingOn({ text_matches: "arrived" });
  list.push(stay(0));
  await poll();
  expect(queued()).toEqual([]);
});

test("a stay that began before the agent was created is no arrival for it", async () => {
  const { list, poll, queued } = await waitingOn({ channels: ["places"] });
  list.push(stay(0, { arrivedAt: iso(clock().getTime() - HOUR) }));
  await poll();
  expect(queued()).toEqual([]);
});

test("a wait refuses coordinates alone, a radius alone, and coordinates on a channel with no point", async () => {
  const { rewait } = await waitingOn({ channels: ["places"] });
  const refusals = async (...filters: Partial<EventFilter>[]) =>
    (await Promise.all(filters.map((f) => rewait(f)))).map((r) =>
      "error" in r ? r.error : null
    );
  expect(
    await refusals(
      { channels: ["places"], latitude: SITE.latitude },
      { channels: ["places"], radius_m: 50 },
      { channels: ["payments"], ...SITE },
      { channels: ["places"], radius_m: 50, ...SITE }
    )
  ).toEqual([
    "`latitude` and `longitude` go together",
    "`radius_m` needs `latitude` and `longitude`",
    "no channel named holds a place: coordinates need `places`",
    null,
  ]);
});

test("a failing read queues nothing and the next wake says so", async () => {
  const { desk, fake, lifelog, list, poll, queued } = await waitingOn({
    channels: ["places"],
  });
  lifelog.why = "lifelog: down";
  list.push(stay(0));
  await poll();
  expect(queued()).toEqual([]);
  advance(HOUR);
  await wakeDue(desk);
  expect(fake.said.at(-1)?.message).toMatch(UNREAD);
});

test("a read of stays gives up after 10 seconds, so a hanging lifelog never holds the desk's tick for long", async () => {
  const asked: unknown[] = [];
  await placesChannelOf((...args: unknown[]) => {
    asked.push(args[1]);
    return Promise.resolve([]);
  }).read(clock().getTime());
  expect(asked).toEqual([10]);
});
