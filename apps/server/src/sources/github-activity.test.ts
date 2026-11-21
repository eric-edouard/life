import { expect, spyOn, test } from "bun:test";
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

/**
 * A made-up `gh`: each repo's events and ETag, an owner's repos, what fails (a repo or an owner), what is cut short (a
 * repo whose answer is killed halfway), and every command and timeout it was given.
 */
function fakeGh() {
  const feeds = new Map<string, { etag: string; events: unknown[] }>();
  const owners = new Map<string, string[]>();
  const failing = new Set<string>();
  const cut = new Set<string>();
  const asked: string[][] = [];
  const timeouts: number[] = [];
  const answer = (code: number, stdout: string, killed: unknown = null) =>
    Promise.resolve({ code, killed, stderr: "", stdout });
  const run = (cmd: string[], o: { timeout: number }) => {
    asked.push(cmd);
    timeouts.push(o.timeout);
    if (cmd[1] === "repo") {
      const owner = cmd[3] ?? "";
      return failing.has(owner)
        ? answer(1, "")
        : answer(0, (owners.get(owner) ?? []).join("\n"));
    }
    const repo = EVENTS_PATH.exec(cmd.at(-1) ?? "")?.[1] ?? "";
    if (failing.has(repo)) {
      return answer(1, "HTTP/2.0 404 Not Found\r\n\r\n{}");
    }
    const feed = feeds.get(repo) ?? { etag: '"e0"', events: [] };
    const sent = cmd.find((a) => a.startsWith("If-None-Match: "));
    if (sent === `If-None-Match: ${feed.etag}`) {
      return answer(
        1,
        `HTTP/2.0 304 Not Modified\r\nEtag: ${feed.etag}\r\n\r\n`
      );
    }
    const whole = `HTTP/2.0 200 OK\r\nEtag: ${feed.etag}\r\nX-Poll-Interval: 60\r\n\r\n${JSON.stringify(feed.events)}`;
    return cut.has(repo)
      ? answer(-1, whole.slice(0, -5), "SIGTERM")
      : answer(0, whole);
  };
  return {
    asked,
    cut,
    failing,
    feeds,
    owners,
    run: run as never,
    timeouts,
  };
}

/** A minute and a second on: past a repo's poll interval. */
const NEXT = MIN + 1000;

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
  expect(await read(["acme/app"], T0 + NEXT)).toEqual([]);
  expect(g.asked[1]).toContain('If-None-Match: "e1"');
  g.feeds.set("acme/app", {
    etag: '"e2"',
    events: [
      event("9", "IssuesEvent", { action: "closed", issue: { number: 3 } }),
    ],
  });
  const next = await read(["acme/app"], T0 + 2 * NEXT);
  expect(next.map((a) => [a.id, a.kind, a.link])).toEqual([
    ["9", "issue.closed", "https://github.com/acme/app/issues/3"],
  ]);
});

test("`owner/*` is every repo of the owner, listed once an hour", async () => {
  const g = fakeGh();
  g.owners.set("acme", ["acme/app", "acme/site"]);
  const read = githubActivityReader({ run: g.run });
  await read(["acme/*", "ACME/app"], T0);
  await read(["acme/*"], T0 + NEXT);
  const lists = () => g.asked.filter((c) => c[1] === "repo").length;
  const events = g.asked.filter((c) => c[1] === "api").map((c) => c.at(-1));
  expect(lists()).toBe(1);
  expect(events).toEqual([
    "repos/acme/app/events?per_page=100",
    "repos/acme/site/events?per_page=100",
    "repos/acme/app/events?per_page=100",
    "repos/acme/site/events?per_page=100",
  ]);
  await read(["acme/*"], T0 + HOUR + NEXT);
  expect(lists()).toBe(2);
});

test("an owner that cannot be listed stops no other repo, and is asked again a minute on", async () => {
  const g = fakeGh();
  g.failing.add("gone");
  const read = githubActivityReader({ run: g.run });
  expect(await read(["gone/*", "acme/app"], T0)).toEqual([]);
  expect(g.asked.map((c) => c[1])).toEqual(["repo", "api"]);
  await read(["gone/*"], T0 + 30_000);
  expect(g.asked).toHaveLength(2);
  await expect(read(["gone/*"], T0 + NEXT)).rejects.toThrow("gone/*");
  expect(g.asked).toHaveLength(3);
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
  await read(many, T0 + NEXT);
  const second = g.asked.slice(ACTIVITY_REPOS_MAX).map((c) => c.at(-1));
  expect(second.slice(0, 5)).toEqual(
    many.slice(ACTIVITY_REPOS_MAX).map((r) => `repos/${r}/events?per_page=100`)
  );
});

test("a repo that fails waits its turn like one read, so the cap never starves a healthy repo; a read where every ask failed throws", async () => {
  const g = fakeGh();
  const gone = Array.from(
    { length: ACTIVITY_REPOS_MAX },
    (_, i) => `acme/gone${i}`
  );
  for (const r of gone) {
    g.failing.add(r);
  }
  const read = githubActivityReader({ run: g.run });
  await expect(read([...gone, "acme/app"], T0)).rejects.toThrow(
    "acme/gone0: HTTP 404"
  );
  await read([...gone, "acme/app"], T0 + NEXT);
  expect(g.asked[ACTIVITY_REPOS_MAX]?.at(-1)).toBe(
    "repos/acme/app/events?per_page=100"
  );
});

test("one owner is listed a read, so slow failing owners never starve a named repo", async () => {
  const g = fakeGh();
  const gone = Array.from({ length: 12 }, (_, i) => `gone${i}/*`);
  for (const o of gone) {
    g.failing.add(o.slice(0, -2));
  }
  const read = githubActivityReader({ run: g.run });
  await read([...gone, "acme/app"], T0);
  expect(g.asked.map((c) => c.at(-1))).toEqual([
    ".[].nameWithOwner",
    "repos/acme/app/events?per_page=100",
  ]);
});

test("every repo named or listed shares one rotation: a big owner never starves a small one", async () => {
  const g = fakeGh();
  g.owners.set(
    "big",
    Array.from({ length: 50 }, (_, i) => `big/r${i}`)
  );
  g.owners.set("small", ["small/app"]);
  const read = githubActivityReader({ run: g.run });
  for (let i = 0; i < 4; i += 1) {
    // biome-ignore lint/performance/noAwaitInLoops: reads follow one another
    await read(["big/*", "small/*"], T0 + i * NEXT);
  }
  expect(g.asked.some((c) => c.at(-1)?.startsWith("repos/small/app/"))).toBe(
    true
  );
});

test("a failed read keeps saying so on the reads that ask nothing, until an ask answers", async () => {
  const g = fakeGh();
  g.failing.add("acme/app");
  const read = githubActivityReader({ run: g.run });
  await expect(read(["acme/app"], T0)).rejects.toThrow("acme/app");
  await expect(read(["acme/app"], T0 + 30_000)).rejects.toThrow("acme/app");
  g.failing.clear();
  expect(await read(["acme/app"], T0 + NEXT)).toEqual([]);
  expect(await read(["acme/app"], T0 + NEXT + 30_000)).toEqual([]);
});

test("an owner listed again with no repos ends the outage its failed list began", async () => {
  const g = fakeGh();
  g.failing.add("empty");
  const read = githubActivityReader({ run: g.run });
  await expect(read(["empty/*"], T0)).rejects.toThrow("empty/*");
  g.failing.clear();
  expect(await read(["empty/*"], T0 + NEXT)).toEqual([]);
  expect(await read(["empty/*"], T0 + NEXT + 30_000)).toEqual([]);
});

test("no more than the cap of repos is asked in any minute, across reads", async () => {
  const g = fakeGh();
  const many = Array.from(
    { length: ACTIVITY_REPOS_MAX * 2 },
    (_, i) => `acme/r${i}`
  );
  const read = githubActivityReader({ run: g.run });
  await read(many, T0);
  await read(many, T0 + 30_000);
  expect(g.asked).toHaveLength(ACTIVITY_REPOS_MAX);
});

test("an answer cut short keeps no ETag: the next ask has the last good one, and gets the events", async () => {
  const g = fakeGh();
  g.feeds.set("acme/app", {
    etag: '"e1"',
    events: [
      event("5", "IssuesEvent", { action: "reopened", issue: { number: 2 } }),
    ],
  });
  g.cut.add("acme/app");
  const read = githubActivityReader({ run: g.run });
  await expect(read(["acme/app"], T0)).rejects.toThrow("gh didn't answer");
  g.cut.clear();
  const again = await read(["acme/app"], T0 + NEXT);
  expect(g.asked[1]).not.toContain("-H");
  expect(again.map((a) => a.kind)).toEqual(["issue.reopened"]);
});

test("a read stops at its time, each ask bounded by what is left; the rest are asked on the next read", async () => {
  const g = fakeGh();
  // A clock each answer moves by 300 ms, so the read's budget is spent by the asks alone.
  let now = 0;
  const timer = spyOn(performance, "now").mockImplementation(() => now);
  const run = ((cmd: string[], o: { timeout: number }) => {
    now += 300;
    return (g.run as (c: string[], t: { timeout: number }) => unknown)(cmd, o);
  }) as never;
  const repos = ["acme/a", "acme/b", "acme/c", "acme/d"];
  const read = githubActivityReader({ readMs: 500, run });
  const asked = () => g.asked.map((cmd) => cmd.at(-1));
  try {
    await read(repos, T0);
    await read(repos, T0 + 1000);
  } finally {
    timer.mockRestore();
  }
  expect(asked()).toEqual(
    repos.map((repo) => `repos/${repo}/events?per_page=100`)
  );
  expect(g.timeouts).toEqual([500, 200, 500, 200]);
});
