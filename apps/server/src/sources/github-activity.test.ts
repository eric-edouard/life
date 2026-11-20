import { expect, test } from "bun:test";
import { HOUR, MIN } from "../core/clock";
import { ACTIVITY_REPOS_MAX, githubActivityReader } from "./github";

// The GitHub activity a wait names, read through a made-up `gh`: conditional requests, GitHub's poll interval, owners'
// repos listed once an hour, the cap, and the kinds kept.

const EVENTS_PATH = /repos\/(.+)\/events/;
const T0 = Date.parse("2026-11-19T10:00:00.000Z");

/** A repo event of `type` on made-up `repo`. */
const event = (
  id: string,
  type: string,
  payload: object,
  repo = "acme/app"
) => ({
  actor: { login: "test-dev" },
  created_at: "2026-11-19T09:59:00Z",
  id,
  payload,
  repo: { name: repo },
  type,
});

/** A made-up `gh`: each repo's events and ETag, an owner's repos, and every command it was asked. */
function fakeGh() {
  const feeds = new Map<string, { etag: string; events: unknown[] }>();
  const owners = new Map<string, string[]>();
  const failing = new Set<string>();
  const asked: string[][] = [];
  const answer = (code: number, stdout: string) => ({
    code,
    killed: null,
    stderr: "",
    stdout,
  });
  const run = (cmd: string[]) => {
    asked.push(cmd);
    if (cmd[1] === "repo") {
      return Promise.resolve(
        answer(0, (owners.get(cmd[3] ?? "") ?? []).join("\n"))
      );
    }
    const repo = EVENTS_PATH.exec(cmd.at(-1) ?? "")?.[1] ?? "";
    if (failing.has(repo)) {
      return Promise.resolve(answer(1, "HTTP/2.0 404 Not Found\r\n\r\n{}"));
    }
    const feed = feeds.get(repo) ?? { etag: '"e0"', events: [] };
    const sent = cmd.find((a) => a.startsWith("If-None-Match: "));
    if (sent === `If-None-Match: ${feed.etag}`) {
      return Promise.resolve(
        answer(1, `HTTP/2.0 304 Not Modified\r\nEtag: ${feed.etag}\r\n\r\n`)
      );
    }
    return Promise.resolve(
      answer(
        0,
        `HTTP/2.0 200 OK\r\nEtag: ${feed.etag}\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify(feed.events)}`
      )
    );
  };
  return { asked, failing, feeds, owners, run: run as never };
}

test("each kind kept is read as its facts; a push is dropped; a pull request's own event gets its link from its number", async () => {
  const g = fakeGh();
  g.feeds.set("acme/app", {
    etag: '"e1"',
    events: [
      event("1", "PushEvent", {}),
      event("2", "PullRequestEvent", { action: "opened", number: 7 }),
      event("3", "IssueCommentEvent", {
        action: "created",
        comment: {
          body: "Looks good",
          html_url: "https://github.com/acme/app/issues/5#c1",
        },
        issue: { number: 5, title: "Test crash" },
      }),
      event("4", "PullRequestReviewEvent", {
        action: "created",
        pull_request: { number: 7 },
        review: {
          body: null,
          html_url: "https://github.com/acme/app/pull/7#r1",
        },
      }),
    ],
  });
  const read = await githubActivityReader({ run: g.run })(["acme/app"], T0);
  expect(read).toEqual([
    {
      at: "2026-11-19T09:59:00.000Z",
      id: "2",
      kind: "pr.opened",
      link: "https://github.com/acme/app/pull/7",
      number: 7,
      repo: "acme/app",
      who: "test-dev",
      words: "",
    },
    {
      at: "2026-11-19T09:59:00.000Z",
      id: "3",
      kind: "comment",
      link: "https://github.com/acme/app/issues/5#c1",
      number: 5,
      repo: "acme/app",
      who: "test-dev",
      words: "Test crash\nLooks good",
    },
    {
      at: "2026-11-19T09:59:00.000Z",
      id: "4",
      kind: "review",
      link: "https://github.com/acme/app/pull/7#r1",
      number: 7,
      repo: "acme/app",
      who: "test-dev",
      words: "",
    },
  ]);
});

test("a repo is asked again only after its poll interval, with its ETag; a 304 gives nothing; a new ETag gives the new events", async () => {
  const g = fakeGh();
  g.feeds.set("acme/app", { etag: '"e1"', events: [] });
  const read = githubActivityReader({ run: g.run });
  await read(["acme/app"], T0);
  expect(await read(["acme/app"], T0 + 30_000)).toEqual([]);
  expect(g.asked).toHaveLength(1);
  expect(g.asked[0]).not.toContain("-H");
  expect(await read(["acme/app"], T0 + MIN)).toEqual([]);
  expect(g.asked[1]).toContain('If-None-Match: "e1"');
  g.feeds.set("acme/app", {
    etag: '"e2"',
    events: [
      event("9", "IssuesEvent", { action: "closed", issue: { number: 3 } }),
    ],
  });
  const next = await read(["acme/app"], T0 + 2 * MIN);
  expect(next.map((a) => [a.id, a.kind, a.link])).toEqual([
    ["9", "issue.closed", "https://github.com/acme/app/issues/3"],
  ]);
});

test("`owner/*` is every repo of the owner, listed once an hour", async () => {
  const g = fakeGh();
  g.owners.set("acme", ["acme/app", "acme/site"]);
  const read = githubActivityReader({ run: g.run });
  await read(["acme/*", "ACME/app"], T0);
  await read(["acme/*"], T0 + MIN);
  const lists = () => g.asked.filter((c) => c[1] === "repo").length;
  const events = g.asked.filter((c) => c[1] === "api").map((c) => c.at(-1));
  expect(lists()).toBe(1);
  expect(events).toEqual([
    "repos/acme/app/events?per_page=100",
    "repos/acme/site/events?per_page=100",
    "repos/acme/app/events?per_page=100",
    "repos/acme/site/events?per_page=100",
  ]);
  await read(["acme/*"], T0 + HOUR + MIN);
  expect(lists()).toBe(2);
});

test("past the cap, the longest unread repos are read first", async () => {
  const g = fakeGh();
  const many = Array.from(
    { length: ACTIVITY_REPOS_MAX + 5 },
    (_, i) => `acme/r${i}`
  );
  const read = githubActivityReader({ run: g.run });
  await read(many, T0);
  expect(g.asked).toHaveLength(ACTIVITY_REPOS_MAX);
  await read(many, T0 + MIN);
  const second = g.asked.slice(ACTIVITY_REPOS_MAX).map((c) => c.at(-1));
  expect(second.slice(0, 5)).toEqual(
    many.slice(ACTIVITY_REPOS_MAX).map((r) => `repos/${r}/events?per_page=100`)
  );
});

test("a repo that fails is skipped and asked again; a read where every repo failed throws", async () => {
  const g = fakeGh();
  g.failing.add("acme/gone");
  const read = githubActivityReader({ run: g.run });
  expect(await read(["acme/app", "acme/gone"], T0)).toEqual([]);
  await expect(read(["acme/gone"], T0 + 1000)).rejects.toThrow(
    "acme/gone: HTTP 404"
  );
});
