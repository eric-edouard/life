import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, DAY, HOUR, MIN } from "../core/clock";
import { agentOf } from "../host/desk-read";
import { EVENTS_SETTLE } from "./agent-wait";
import { pollMessages, readPeopleOnce, wakeDue } from "./desk-clock";
import { advance, setup } from "./test-desk";

// A deadline wake says since when to sweep; an event wake and a first turn do not. Made-up agent and chat.

afterEach(() => {
  setSystemTime();
});

const SINCE = "since your last turn ended";

test("a deadline wake after an ended turn states when that turn ended", async () => {
  const { desk, fake, waiting } = setup();
  await waiting(HOUR);
  const endedAt = clock().toISOString();
  advance(HOUR + MIN);
  await wakeDue(desk);
  const wake = fake.said.at(-1)?.message ?? "";
  expect(wake).toContain("Woken by the desk: deadline.");
  expect(wake).toContain(
    `Your last turn ended at ${endedAt}: sweep what happened since then on your subject`
  );
});

test("an event wake says nothing of it", async () => {
  const { desk, fake, waiting, write } = setup();
  await waiting(DAY);
  await pollMessages(desk, readPeopleOnce());
  advance(HOUR);
  write();
  await pollMessages(desk, readPeopleOnce());
  advance(EVENTS_SETTLE);
  await wakeDue(desk);
  const wake = fake.said.at(-1)?.message ?? "";
  expect(wake).toContain("Woken by the desk: event.");
  expect(wake).not.toContain(SINCE);
});

test("a first turn says nothing of it", async () => {
  const { desk, fake, waiting } = setup();
  await waiting(HOUR);
  expect(fake.said.some((s) => s.message.includes(SINCE))).toBe(false);
  expect(desk.db.query("select 1 from turn").all()).toHaveLength(1);
});

test("a deadline wake that starts a fresh session (the old one is gone) carries the same line after the packet", async () => {
  const { desk, fake, waiting } = setup();
  const id = await waiting(HOUR);
  const endedAt = clock().toISOString();
  fake.sessions.delete(agentOf(desk.db, id)?.session ?? "");
  advance(HOUR + MIN);
  await wakeDue(desk);
  const start = fake.said.at(-1)?.message ?? "";
  expect(start).toContain("Your subject");
  expect(start).toContain(`Your last turn ended at ${endedAt}: sweep`);
});
