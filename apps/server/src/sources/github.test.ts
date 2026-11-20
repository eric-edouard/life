import { afterAll, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_POST_SIGNATURE } from "../core/names";
import { incomingArchived } from "./archived";
import { githubCopier, githubSend, openGithub, readGithub } from "./github";

afterAll(() => setSystemTime());

const T0 = new Date("2026-11-19T10:00:00.000Z").getTime();
const at = (s: number) => setSystemTime(new Date(T0 + s * 1000));
const ok: { code: number; killed: unknown; stderr: string; stdout: string } = {
  code: 0,
  killed: null,
  stderr: "",
  stdout: "",
};

interface Item {
  [k: string]: unknown;
}
const issue = (number: number, over: Item = {}) => ({
  body: "it breaks",
  created_at: "2026-11-18T08:00:00Z",
  number,
  title: "Crash",
  updated_at: "2026-11-18T08:00:00Z",
  user: { login: "Ana" },
  ...over,
});
const comment = (id: number, n: number, over: Item = {}) => ({
  body: "me too",
  created_at: "2026-11-18T09:00:00Z",
  html_url: `https://github.com/o/r/issues/${n}#issuecomment-${id}`,
  id,
  issue_url: `https://api.github.com/repos/o/r/issues/${n}`,
  updated_at: "2026-11-18T09:00:00Z",
  user: { login: "Bob" },
  ...over,
});

/** A made-up `gh`: `api user` is `login`, each feed answers what `feeds` holds; every command line is kept. */
function fakeGh(login = "bOB") {
  const calls: string[][] = [];
  const feeds: Record<string, Item[]> = {};
  const state = { fail: false as boolean, loginFails: false as boolean };
  const run = (cmd: string[]) => {
    calls.push(cmd);
    const path = cmd[2] ?? "";
    if (path === "user") {
      return Promise.resolve(
        state.loginFails
          ? { ...ok, code: 1, stderr: "not logged in" }
          : { ...ok, stdout: `${login}\n` }
      );
    }
    if (state.fail) {
      return Promise.resolve({ ...ok, code: 1, stderr: "HTTP 502" });
    }
    const feed = path.split("?")[0] ?? "";
    return Promise.resolve({
      ...ok,
      stdout: JSON.stringify(feeds[feed] ?? []),
    });
  };
  return {
    calls,
    feedCalls: () => calls.filter((c) => c[2] !== "user"),
    feeds,
    run: run as never,
    state,
  };
}

const dir = () => mkdtempSync(join(tmpdir(), "github-"));
const EPOCH = new Date(0);

test("the copier writes each issue and comment under its issue's chat, skips pull requests, and marks his own whatever the login's case", () => {
  const g = fakeGh();
  g.feeds["repos/o/r/issues"] = [
    issue(1),
    issue(2, { pull_request: {} }),
    issue(3, { body: null, title: "Idea", user: null }),
  ];
  g.feeds["repos/o/r/issues/comments"] = [
    comment(11, 1),
    comment(12, 2, {
      html_url: "https://github.com/o/r/pull/2#issuecomment-12",
    }),
    comment(13, 1, { user: { login: "ANA" } }),
  ];
  const archive = dir();
  at(0);
  return githubCopier({ archive, repos: () => ["o/r"], run: g.run })().then(
    (added) => {
      expect(added).toBe(4);
      const read = readGithub(EPOCH, archive, undefined, () => ["o/r"]);
      expect(
        read.map((e) => [e.id, e.chat, e.chatName, e.sender, e.fromMe, e.text])
      ).toEqual([
        [
          "github:o/r#1/0",
          "o/r#1",
          "Crash",
          "Ana",
          false,
          "Crash\n\nit breaks",
        ],
        ["github:o/r#3/0", "o/r#3", "Idea", "ghost", false, "Idea"],
        ["github:o/r#1/11", "o/r#1", "Crash", "me", true, "me too"],
        ["github:o/r#1/13", "o/r#1", "Crash", "ANA", false, "me too"],
      ]);
    }
  );
});

test("a post of his login ending with the agents' signature is his agent's, not his words; anyone else's keeps its sender", async () => {
  const g = fakeGh();
  const signed = `Found the cause.\n${AGENT_POST_SIGNATURE}\n`;
  g.feeds["repos/o/r/issues/comments"] = [
    comment(21, 1, { body: signed }),
    comment(22, 1, {
      body: `quoting: ${AGENT_POST_SIGNATURE} then his own words`,
    }),
    comment(23, 1, { body: signed, user: { login: "Ana" } }),
  ];
  const archive = dir();
  at(0);
  await githubCopier({ archive, repos: () => ["o/r"], run: g.run })();
  const read = readGithub(EPOCH, archive, undefined, () => ["o/r"]);
  expect(read.map((e) => [e.id, e.sender, e.fromMe])).toEqual([
    ["github:o/r#1/21", "agent", false],
    ["github:o/r#1/22", "me", true],
    ["github:o/r#1/23", "Ana", false],
  ]);
});

test("an edited comment is a second version: read gives the last, incoming counts the comment once; a title edit renames its comments' chat", async () => {
  const g = fakeGh();
  g.feeds["repos/o/r/issues"] = [issue(1)];
  g.feeds["repos/o/r/issues/comments"] = [comment(11, 1)];
  const archive = dir();
  const copy = githubCopier({ archive, repos: () => ["o/r"], run: g.run });
  at(0);
  await copy();
  g.feeds["repos/o/r/issues"] = [
    issue(1, { title: "Crash on start", updated_at: "2026-11-19T08:00:00Z" }),
  ];
  g.feeds["repos/o/r/issues/comments"] = [
    comment(11, 1, { body: "me too, v2", updated_at: "2026-11-19T09:00:00Z" }),
  ];
  at(30);
  expect(await copy()).toBe(2);
  const rows = openGithub(archive)
    .query<{ n: number }, []>(
      "select count(*) as n from messages where eventId = '11'"
    )
    .get();
  expect(rows?.n).toBe(2);
  const read = readGithub(EPOCH, archive, undefined, () => ["o/r"]);
  expect(read.map((e) => [e.id, e.text, e.chatName])).toEqual([
    ["github:o/r#1/0", "Crash on start\n\nit breaks", "Crash on start"],
    ["github:o/r#1/11", "me too, v2", "Crash on start"],
  ]);
  const { rows: incoming } = incomingArchived("github", "eventId", 1, archive);
  expect(incoming.map((r) => r.id)).toEqual([
    "github:o/r#1/0",
    "github:o/r#1/11",
  ]);
});

test("pacing: a second call within 20 s asks nothing; the next query starts from the cursor", async () => {
  const g = fakeGh();
  g.feeds["repos/o/r/issues"] = [
    issue(1, { updated_at: "2026-11-18T12:00:00Z" }),
  ];
  const copy = githubCopier({
    archive: dir(),
    repos: () => ["o/r"],
    run: g.run,
  });
  at(0);
  await copy();
  const first = g.calls.length;
  expect(g.feedCalls().every((c) => !c[2]?.includes("since="))).toBe(true);
  at(19);
  expect(await copy()).toBe(0);
  expect(g.calls.length).toBe(first);
  at(20);
  await copy();
  const second = g.feedCalls().filter((c) => c[2]?.includes("/issues?"));
  expect(second.at(-1)?.[2]).toContain("&since=2026-11-18T12:00:00Z");
  // The comments feed had nothing, so it still has no cursor.
  expect(g.feedCalls().at(-1)?.[2]).not.toContain("since=");
});

test("a failing gh throws again on each call of its pause without asking, and the pause doubles", async () => {
  const g = fakeGh();
  g.state.fail = true;
  const copy = githubCopier({
    archive: dir(),
    repos: () => ["o/r"],
    run: g.run,
  });
  at(0);
  await expect(copy()).rejects.toThrow("gh failed: HTTP 502");
  const asked = () => g.calls.length;
  const n1 = asked();
  at(19);
  await expect(copy()).rejects.toThrow("HTTP 502");
  expect(asked()).toBe(n1);
  // The pause ends at 20 s: asked again, failing again, now paused 40 s.
  at(20);
  await expect(copy()).rejects.toThrow("HTTP 502");
  const n2 = asked();
  expect(n2).toBeGreaterThan(n1);
  at(59);
  await expect(copy()).rejects.toThrow("HTTP 502");
  expect(asked()).toBe(n2);
  g.state.fail = false;
  at(60);
  expect(await copy()).toBe(0);
  expect(asked()).toBeGreaterThan(n2);
  // Healed: no more rethrow within the next poll.
  at(61);
  expect(await copy()).toBe(0);
});

test("only the listed repos are asked; none listed means no gh call at all; read drops a repo no longer listed", async () => {
  const g = fakeGh();
  g.feeds["repos/o/r/issues"] = [issue(1)];
  g.feeds["repos/o/s/issues"] = [issue(5)];
  const archive = dir();
  at(0);
  expect(await githubCopier({ archive, repos: () => [], run: g.run })()).toBe(
    0
  );
  expect(g.calls).toEqual([]);
  let listed = ["o/r", "o/s"];
  await githubCopier({ archive, repos: () => listed, run: g.run })();
  const paths = g.feedCalls().map((c) => c[2]?.split("?")[0]);
  expect(new Set(paths)).toEqual(
    new Set([
      "repos/o/r/issues",
      "repos/o/r/issues/comments",
      "repos/o/s/issues",
      "repos/o/s/issues/comments",
    ])
  );
  listed = ["o/s"];
  expect(
    readGithub(EPOCH, archive, undefined, () => listed).map((e) => e.chat)
  ).toEqual(["o/s#5"]);
});

const NO_ENV = { env: expect.anything() };

/** A send path over a fake `run` that answers `answer`, keeping each command and its options. */
function sender(answer: Partial<typeof ok> = {}, repos = ["o/r"]) {
  const sent: { cmd: string[]; o: { stdin?: string; timeout: number } }[] = [];
  const run = ((cmd: string[], o: { stdin?: string; timeout: number }) => {
    sent.push({ cmd, o });
    return Promise.resolve({ ...ok, ...answer });
  }) as never;
  return { path: githubSend({ repos: () => repos, run }), sent };
}

test("a comment and a new issue go through gh api with the JSON on stdin, and answer the id read gives them", async () => {
  const c = sender({ stdout: '{"id":99}' });
  expect(
    await c.path.send(
      { chat: "o/r#7", text: "On it @ana", to: "x" } as never,
      "t1",
      () => undefined
    )
  ).toBe("github:o/r#7/99");
  expect(c.sent[0]?.cmd).toEqual([
    "gh",
    "api",
    "--method",
    "POST",
    "repos/o/r/issues/7/comments",
    "--input",
    "-",
  ]);
  expect(c.sent[0]?.o).toMatchObject({
    stdin: '{"body":"On it @ana"}',
    timeout: 30_000,
    ...NO_ENV,
  });
  const n = sender({ stdout: '{"number":12}' });
  expect(
    await n.path.send(
      { chat: "o/r", subject: "Title", text: "Body", to: "x" } as never,
      "t2",
      () => undefined
    )
  ).toBe("github:o/r#12/0");
  expect(n.sent[0]?.cmd).toEqual([
    "gh",
    "api",
    "--method",
    "POST",
    "repos/o/r/issues",
    "--input",
    "-",
  ]);
  expect(n.sent[0]?.o.stdin).toBe('{"body":"Body","title":"Title"}');
  // An answer without an id is still a sent message.
  expect(
    await sender({ stdout: "oops" }).path.send(
      { chat: "o/r#7", text: "x", to: "x" } as never,
      "t3",
      () => undefined
    )
  ).toBe("github: no id came back");
});

test("what GitHub can't take is refused before anything is sent", async () => {
  const { path } = sender();
  const refuse = (d: Record<string, unknown>) =>
    path.refusal({ chat: "o/r#7", text: "hi", to: "x", ...d } as never);
  expect(await refuse({})).toBeUndefined();
  const rejected = await Promise.all(
    [
      { file: {} },
      { reaction: "👍" },
      { onMessage: "m" },
      { mentions: [{}] },
    ].map(refuse)
  );
  expect(rejected.every((r) => r?.includes("text only"))).toBe(true);
  expect(await refuse({ text: "  " })).toBe("GitHub needs `text`");
  expect(await refuse({ chat: "o/r", text: "hi" })).toBe(
    "a new issue needs a `subject`"
  );
  expect(await refuse({ chat: "o/r", subject: "T" })).toBeUndefined();
  expect(await refuse({ chat: "x/y", subject: "T" })).toContain(
    "isn't an issue of a listed repo"
  );
  expect(await refuse({ chat: "x/y#1" })).toContain(
    "isn't an issue of a listed repo"
  );
  expect(await refuse({ subject: "T" })).toBe("a comment takes no `subject`");
  expect(await path.opens?.("o/r")).toBe("a new issue");
  expect(await path.opens?.("x/y")).toBeUndefined();
  expect(path.holds(["o/r#1", "x/y#1", "o/r"])).toEqual(["o/r#1"]);
});

test("a send's outcome: killed may have gone, exit -1 or an HTTP 4xx did not go, any other failure may have gone", async () => {
  const to = { chat: "o/r#7", text: "hi", to: "x" } as never;
  const outcome = (r: Partial<typeof ok>) =>
    sender(r)
      .path.send(to, "t", () => undefined)
      .then(
        () => "",
        (e: Error) => e.message
      );
  expect(await outcome({ killed: "SIGTERM" })).toStartWith("may have gone");
  expect(await outcome({ code: -1, stderr: "spawn gh ENOENT" })).toStartWith(
    "not sent"
  );
  expect(
    await outcome({ code: 1, stderr: "gh: Validation Failed (HTTP 422)" })
  ).toStartWith("not sent");
  expect(
    await outcome({ code: 1, stderr: "gh: Bad Gateway (HTTP 502)" })
  ).toStartWith("may have gone");
  expect(await outcome({ code: 1, stderr: "connection reset" })).toStartWith(
    "may have gone"
  );
});

test("the send is blocked while gh isn't signed in", async () => {
  const g = fakeGh();
  const path = githubSend({ repos: () => ["o/r"], run: g.run });
  expect(await path.block()).toBeUndefined();
  g.state.loginFails = true;
  expect(await path.block()).toContain("gh auth login");
});
