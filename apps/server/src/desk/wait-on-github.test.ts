import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clock, HOUR, MIN } from "../core/clock";
import { queuedEvents } from "../host/desk-read";
import { githubActivityChannelOf } from "../host/event-channels";
import type { EventFilter } from "../records/registered-agent";
import type { GithubActivity } from "../sources/github";
import { register, setWait } from "./agent-actions";
import { readPeopleOnce, wakeDue } from "./desk-clock";
import { pollChannels } from "./event-queue";
import { advance, ahead, asgOf, on, setup } from "./test-desk";

// An agent's wait on GitHub activity: only the repos its waits name are read, a repo or an owner's repos wake it, and a
// wake hands the activity's facts, never its title or body.

afterEach(() => {
  setSystemTime();
});

/** A made-up activity on `repo`, now. */
const activity = (id: string, repo: string, words = ""): GithubActivity => ({
  at: clock().toISOString(),
  id,
  kind: "comment",
  link: `https://github.com/${repo}/issues/1#c${id}`,
  number: 1,
  repo,
  who: "test-dev",
  words,
});

/**
 * A desk whose GitHub holds `list` (read only while `own.isOwn`: his own Life), and an agent after its first turn
 * waiting on `filters`; `asked` keeps the repos each read was given.
 */
async function waitingOn(...filters: Partial<EventFilter>[]) {
  const s = setup();
  const list: GithubActivity[] = [];
  const asked: string[][] = [];
  const own = { isOwn: true };
  s.desk.channels = [
    githubActivityChannelOf(
      (repos) => {
        asked.push(repos);
        return Promise.resolve(list);
      },
      () => own.isOwn
    ),
  ];
  const id = register(s.desk, {
    brief: "Test brief: watch the release",
    folder: s.dir,
    runtime: "fake",
  });
  await wakeDue(s.desk);
  const rewait = (...events: Partial<EventFilter>[]) =>
    setWait(s.desk, on(s.desk, id), {
      events,
      reason: "a review",
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
  return { asked, list, own, poll, queued, rewait, set };
}

test("a wait on a repo and on an owner's repos is woken by their activity only, and reads only what it names", async () => {
  const { asked, list, poll, queued, set } = await waitingOn(
    { channels: ["github_activity"], repo: "acme/app" },
    { channels: ["github_activity"], repo: "Tools/*" }
  );
  expect(set).not.toHaveProperty("error");
  list.push(
    activity("1", "acme/app"),
    activity("2", "acme/site"),
    activity("3", "tools/cli"),
    activity("4", "other/tools")
  );
  await poll();
  expect(asked).toEqual([["acme/app", "Tools/*"]]);
  expect(queued().map((e) => [e.name, e.event_id])).toEqual([
    ["github.activity", "github_activity:1"],
    ["github.activity", "github_activity:3"],
  ]);
});

test("a wake hands the facts, never the title or body; `text_matches` tests them", async () => {
  const { list, poll, queued } = await waitingOn({
    channels: ["github_activity"],
    repo: "acme/app",
    text_matches: "release",
  });
  list.push(
    activity("1", "acme/app", "Test release notes\nShip it"),
    activity("2", "acme/app", "Test typo")
  );
  await poll();
  const [wake, ...rest] = queued();
  expect(rest).toEqual([]);
  expect(JSON.parse(wake?.payload ?? "{}")).toEqual({
    at: expect.any(String),
    id: "github_activity:1",
    kind: "comment",
    link: "https://github.com/acme/app/issues/1#c1",
    number: 1,
    repo: "acme/app",
    source: "github_activity",
    who: "test-dev",
  });
});

test("no wait names GitHub: it is never read", async () => {
  const { asked, poll } = await waitingOn({ text_matches: "release" });
  await poll();
  expect(asked).toEqual([]);
});

test("`github_activity` needs a `repo`, and a `repo` needs `github_activity`", async () => {
  const { rewait } = await waitingOn({ text_matches: "x" });
  expect(await rewait({ channels: ["github_activity"] })).toEqual({
    error: "`github_activity` needs a `repo`: `owner/name` or `owner/*`",
  });
  expect(await rewait({ repo: "acme/app" })).toEqual({
    error: "`repo` needs `channels` naming `github_activity`",
  });
  expect(
    await rewait({ channels: ["github_activity"], repo: "acme" })
  ).toHaveProperty("error");
  expect(
    await rewait({
      channels: ["github_activity"],
      quantity: "eur_out",
      repo: "acme/app",
    })
  ).toEqual({
    error:
      "a filter with a `repo` takes no `quantity` or place: no event holds both",
  });
});

test("a second Life (a demo) never reads GitHub: its gh holds his login", async () => {
  const { asked, own, poll, rewait } = await waitingOn({ text_matches: "x" });
  own.isOwn = false;
  expect(
    await rewait({ channels: ["github_activity"], repo: "acme/app" })
  ).toEqual({ error: "GitHub is read only in his own Life" });
  await poll();
  expect(asked).toEqual([]);
});
