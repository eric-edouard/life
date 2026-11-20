import { clock, HOUR, iso, MIN } from "../core/clock";
import { log } from "../core/log";
import { AGENT_POST_SIGNATURE, AGENT_WORD } from "../core/names";
import { cliEnv } from "../core/platform";
import { exec } from "../core/proc";
import { settings } from "../core/settings";
import type { SourceEvent } from "../records/source";
import {
  ARCHIVE,
  insertAll,
  LATEST_VERSIONS,
  matrixArchive,
  newestArchived,
  openArchive,
  readArchived,
} from "./archived";
import type { Outgoing, SendPath } from "./contract";

// The GitHub source: the issues and issue comments of the repos he lists (`githubRepos`), one chat per issue
// (`owner/name#12`), copied into `archive/github.sqlite` (each version kept, like a bridge's) and read from there. The
// only place Life runs `gh` (`scripts/imports.test.ts`). Pull requests and their comments are left out. Beside it, the
// GitHub activity of the repos the agents' waits name (`githubActivityReader`): read for a wake only, never stored.

type Run = Awaited<ReturnType<typeof exec>>;

/** How often the copier asks GitHub: 2 calls a repo each time, well under GitHub's 5,000 an hour. */
const POLL_MS = 20_000;
/** A failing GitHub is asked again after a pause that doubles up to this. */
const PAUSE_MAX = 15 * MIN;
const GH_MS = 15_000;
const SEND_MS = 30_000;
const ISSUE = /^([\w.-]+\/[\w.-]+)#(\d+)$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
/** GitHub refused the request itself (`gh api`'s stderr): nothing was posted. */
const REFUSED = /\(HTTP 4\d\d\)/;

/** The repos he listed: nothing else is read or written. */
const listedRepos = () => settings().githubRepos ?? [];

/** `gh` with the environment a CLI Life starts gets (none of Life's secrets): it holds its own login. */
const gh = (
  run: typeof exec,
  args: string[],
  stdin?: string,
  timeout = GH_MS
) =>
  run(["gh", ...args], {
    env: { ...cliEnv(), GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
    stdin,
    timeout,
  });

/** `gh`'s output, or a throw saying why it failed. */
async function ghOut(run: typeof exec, args: string[], timeout = GH_MS) {
  const r = await gh(run, args, undefined, timeout);
  if (r.killed || r.code !== 0) {
    throw new Error(
      `gh ${r.killed ? "didn't answer" : `failed: ${r.stderr.trim().slice(-200)}`}`
    );
  }
  return r.stdout;
}

/** The login `gh` acts as: his, the one every message he wrote there is from. */
const loginOf = async (run: typeof exec) =>
  (await ghOut(run, ["api", "user", "--jq", ".login"])).trim();

const SCHEMA = `${matrixArchive("")};
  create table if not exists cursors (feed text primary key, since text not null)`;

/** The archive's GitHub store, its tables made. */
export const openGithub = (dir = ARCHIVE) => openArchive(dir, "github", SCHEMA);

interface Issue {
  body: string | null;
  created_at: string;
  number: number;
  pull_request?: unknown;
  title: string;
  updated_at: string;
  user: { login: string } | null;
}
interface Comment {
  body: string | null;
  created_at: string;
  html_url: string;
  id: number;
  issue_url: string;
  updated_at: string;
  user: { login: string } | null;
}

const INSERT = `insert or ignore into messages
  (id, eventId, chat, chatName, sender, senderName, fromMe, at, type, text, deleted, seenAt)
  values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`;

/**
 * An issue's or comment's row in the archive (`INSERT`'s values), none for a pull request or its comment. A post ending
 * with `AGENT_POST_SIGNATURE` is his agent's own (the send guard's), never his words, though his login made it.
 */
function rowOf(repo: string, i: Issue | Comment, me: string, seenAt: string) {
  const login = i.user?.login ?? "ghost";
  const isMine = login.toLowerCase() === me;
  const isAgentPost =
    isMine && (i.body ?? "").trimEnd().endsWith(AGENT_POST_SIGNATURE);
  const sender = isAgentPost ? AGENT_WORD : login;
  const fromMe = isMine && !isAgentPost ? 1 : 0;
  if ("number" in i) {
    if (i.pull_request) {
      return [];
    }
    const text = `${i.title}\n\n${i.body ?? ""}`.trim();
    return [
      [
        0,
        "issue",
        `${repo}#${i.number}`,
        i.title,
        sender,
        sender,
        fromMe,
        i.created_at,
        "issue",
        text,
        seenAt,
      ],
    ];
  }
  if (i.html_url.includes("/pull/")) {
    return [];
  }
  const chat = `${repo}#${i.issue_url.split("/").at(-1)}`;
  return [
    [
      i.id,
      String(i.id),
      chat,
      null,
      sender,
      sender,
      fromMe,
      i.created_at,
      "comment",
      i.body ?? "",
      seenAt,
    ],
  ];
}

/**
 * The copier of the listed repos into the archive (`AppStore.copy`). It asks GitHub at most every 20 s, from each feed's
 * cursor (its last item's `updated_at`), 100 items at most a pass, so a backlog drains and never floods. A failure pauses
 * it (20 s doubling to 15 min) and is thrown again on each pass of the pause, so the archive's incident stays open.
 */
export function githubCopier({
  archive = ARCHIVE,
  repos = listedRepos,
  run = exec,
}: {
  archive?: string;
  repos?: () => string[];
  run?: typeof exec;
} = {}) {
  let next = 0;
  let pause = 0;
  let error: Error | undefined;
  let login: string | undefined;
  // ponytail: one pause for every repo; per-repo pauses if the list grows past one that may fail alone.
  const pass = async () => {
    const list = repos();
    if (!list.length) {
      return 0;
    }
    login ??= await loginOf(run);
    const me = login.toLowerCase();
    const db = openGithub(archive);
    try {
      let added = 0;
      for (const repo of list) {
        for (const feed of ["issues", "comments"] as const) {
          const key = `${repo} ${feed}`;
          const since = db
            .query<{ since: string }, [string]>(
              "select since from cursors where feed = ?"
            )
            .get(key)?.since;
          const path =
            feed === "issues"
              ? `repos/${repo}/issues?state=all&`
              : `repos/${repo}/issues/comments?`;
          const items = JSON.parse(
            // biome-ignore lint/performance/noAwaitInLoops: one feed after another, one gh at a time
            await ghOut(run, [
              "api",
              `${path}sort=updated&direction=asc&per_page=100${since ? `&since=${since}` : ""}`,
            ])
          ) as (Issue | Comment)[];
          const seenAt = iso(clock().getTime());
          const rows = items.flatMap((i) => rowOf(repo, i, me, seenAt));
          added += insertAll(db, INSERT, rows);
          const last = items.at(-1)?.updated_at;
          if (last) {
            db.run(
              "insert into cursors (feed, since) values (?, ?) on conflict (feed) do update set since = excluded.since",
              [key, last]
            );
          }
        }
      }
      return added;
    } finally {
      db.close();
    }
  };
  return async () => {
    const now = clock().getTime();
    if (now < next) {
      if (error) {
        throw error;
      }
      return 0;
    }
    try {
      const added = await pass();
      pause = 0;
      error = undefined;
      next = now + POLL_MS;
      return added;
    } catch (e) {
      pause = Math.min(pause ? pause * 2 : POLL_MS, PAUSE_MAX);
      error = e as Error;
      next = now + pause;
      throw e;
    }
  };
}

/** The archive's copier: one for the process, so its pause and cursor pacing hold across passes. */
export const copyGithub = githubCopier();

/** A message's chat name in SQL (`t` its table's alias): its issue's latest title. */
const titleOf = (t: string) =>
  `(select x.chatName from messages x where x.chat = ${t}.chat and x.eventId = 'issue' order by x.rowid desc limit 1)`;

/** A chat's repo (`owner/name#12` → `owner/name`). */
const repoOf = (chat: string) => ISSUE.exec(chat)?.[1];

/** The issues and comments of the listed repos since `since`, as events; a chat's name is its issue's latest title. */
export function readGithub(
  since: Date,
  archive = ARCHIVE,
  before?: Date,
  repos = listedRepos
): SourceEvent[] {
  const listed = new Set(repos());
  return readArchived(
    "github",
    `select l.id, l.chat, ${titleOf("l")} as chatName,
      l.sender, l.fromMe, l.at, l.type, l.text, l.deleted
      from (${LATEST_VERSIONS}) l`,
    since,
    archive,
    (raw) => raw,
    () => ({ files: [] }),
    before
  ).filter((e) => listed.has(repoOf(e.chat) ?? ""));
}

/** Its newest message, for its card. */
export const newestGithub = () =>
  newestArchived(
    "github",
    `select m.at, coalesce(${titleOf("m")}, '?') || ': ' || m.text as words
      from messages m order by m.at desc limit 1`
  );

/** The send's answer: the posted comment's or issue's id as `read` gives it, or `not sent` / `may have gone`. */
function answerOf(
  r: Run,
  idOf: (out: { id?: number; number?: number }) => string
) {
  if (r.killed) {
    throw new Error("may have gone: gh didn't answer: look at the issue");
  }
  if (r.code === -1 || (r.code !== 0 && REFUSED.test(r.stderr))) {
    throw new Error(`not sent: gh: ${r.stderr.trim().slice(-200)}`);
  }
  if (r.code !== 0) {
    throw new Error(
      `may have gone: gh failed (${r.stderr.trim().slice(-200)}): look at the issue`
    );
  }
  try {
    return idOf(JSON.parse(r.stdout));
  } catch {
    return "github: no id came back";
  }
}

/**
 * The send path into a listed repo (`Descriptor.send`): a comment on an issue (`to` its chat, `owner/name#12`), or a new
 * issue (`to` the repo, `owner/name`, its title the draft's `subject`). Text only; the JSON goes on stdin, never argv.
 */
export function githubSend({
  repos = listedRepos,
  run = exec,
}: {
  repos?: () => string[];
  run?: typeof exec;
} = {}): SendPath {
  const listed = (repo?: string) => Boolean(repo && repos().includes(repo));
  const isNewIssue = (chat: string) => REPO.test(chat) && listed(chat);
  return {
    block: async () => {
      try {
        await loginOf(run);
      } catch (e) {
        return `${(e as Error).message}: run \`gh auth login\``;
      }
    },
    holds: (chats) => chats.filter((c) => listed(repoOf(c))),
    limitMs: () => SEND_MS,
    opens: (chat) =>
      Promise.resolve(isNewIssue(chat) ? "a new issue" : undefined),
    opensHint: "a listed repo as `owner/name` with a `subject` for a new issue",
    opensWithSubject: true,
    refusal: (d: Outgoing) => {
      if (d.file || d.reaction || d.onMessage || d.mentions) {
        return Promise.resolve(
          "GitHub takes text only: no file, reaction, reply or mentions (an @login in the text pings)"
        );
      }
      if (!d.text?.trim()) {
        return Promise.resolve("GitHub needs `text`");
      }
      if (isNewIssue(d.chat)) {
        return Promise.resolve(
          d.subject?.trim() ? undefined : "a new issue needs a `subject`"
        );
      }
      if (!listed(repoOf(d.chat))) {
        return Promise.resolve(`${d.chat} isn't an issue of a listed repo`);
      }
      return Promise.resolve(
        d.subject ? "a comment takes no `subject`" : undefined
      );
    },
    send: async (d, _txn, onHanded) => {
      const issue = ISSUE.exec(d.chat);
      const [path, body] = issue
        ? [`repos/${issue[1]}/issues/${issue[2]}/comments`, { body: d.text }]
        : [`repos/${d.chat}/issues`, { body: d.text, title: d.subject }];
      const r = await gh(
        run,
        ["api", "--method", "POST", path, "--input", "-"],
        JSON.stringify(body),
        SEND_MS
      );
      if (r.code === 0) {
        onHanded?.();
      }
      return answerOf(r, (o) =>
        issue ? `github:${d.chat}/${o.id}` : `github:${d.chat}#${o.number}/0`
      );
    },
  };
}

/** A GitHub activity a wait names, as `githubActivityReader` reads it: its facts, and `words` (its title and body), only tested by a wait's `text_matches`. */
export interface GithubActivity {
  at: string;
  id: string;
  kind: string;
  link: string | null;
  number: number | null;
  repo: string;
  who: string;
  words: string;
}

/**
 * The repo events kept, by GitHub's type, as the kind a wake names; an issue's or pull request's with what was done
 * (`issue.closed`, `issue.labeled`, `pr.merged`: every action GitHub gives); every other type (a push, a star) is dropped.
 */
const ACTIVITY_KINDS: Record<string, string> = {
  IssueCommentEvent: "comment",
  IssuesEvent: "issue.",
  PullRequestEvent: "pr.",
  PullRequestReviewCommentEvent: "review_comment",
  PullRequestReviewEvent: "review",
};
/** The fewest seconds between two reads of one repo's events; GitHub's `X-Poll-Interval` may ask more. */
const ACTIVITY_EVERY_S = 60;
/** How long an owner's repos (`owner/*`) stand before they are listed again. */
const OWNER_REPOS_FOR = HOUR;
/**
 * The most repos one read asks about: 25 a minute is at most 1,500 counted requests an hour, beside the copier's 360 a
 * listed repo, under GitHub's 5,000. A 304 (nothing new since the ETag sent as `If-None-Match`) does not count against
 * that limit for an authenticated request (GitHub's REST API best practices; its events API: "your rate limit is not
 * used"), so a quiet repo costs nothing.
 */
export const ACTIVITY_REPOS_MAX = 25;

interface Said {
  body?: string | null;
  html_url?: string;
  number?: number;
  title?: string;
}
interface RepoEvent {
  actor: { login: string } | null;
  created_at: string;
  id: string;
  payload: {
    action?: string;
    comment?: Said;
    issue?: Said;
    number?: number;
    pull_request?: Said;
    review?: Said;
  };
  repo: { name: string };
  type: string;
}

/** A repo event as an activity, none for a type left out. */
function activityOf(e: RepoEvent): GithubActivity[] {
  const base = ACTIVITY_KINDS[e.type];
  if (!base) {
    return [];
  }
  const kind = base.endsWith(".") ? base + (e.payload.action ?? "?") : base;
  const { comment, issue, pull_request: pr, review } = e.payload;
  const item = issue ?? pr;
  const said = comment ?? review ?? item;
  const number = item?.number ?? e.payload.number ?? null;
  return [
    {
      at: iso(Date.parse(e.created_at)),
      id: e.id,
      kind,
      // A pull request's own event comes with its number only (GitHub's trimmed payloads).
      link:
        said?.html_url ??
        (number
          ? `https://github.com/${e.repo.name}/${base === "issue." ? "issues" : "pull"}/${number}`
          : null),
      number,
      repo: e.repo.name,
      who: e.actor?.login ?? "ghost",
      words: [item?.title, said?.body].filter(Boolean).join("\n"),
    },
  ];
}

const BLANK_LINE = /\r?\n\r?\n/;
const LINE = /\r?\n/;
const STATUS = /^HTTP\/[\d.]+ (\d{3})/;
/** `gh api -i`'s answer: its status, its headers (lower case) and its body. `gh` exits 1 on a 304, so the status decides. */
function parseHttp(r: Run) {
  const [head = "", ...rest] = r.stdout.split(BLANK_LINE);
  const [statusLine = "", ...lines] = head.split(LINE);
  const status = Number(STATUS.exec(statusLine)?.[1] ?? 0);
  const headers = new Map(
    lines.map((l) => {
      const at = l.indexOf(":");
      return [l.slice(0, at).trim().toLowerCase(), l.slice(at + 1).trim()];
    })
  );
  return { body: rest.join("\n\n"), headers, status };
}

/** How long one read may take in all: the desk's tick waits for it, and other agents with it. */
const ACTIVITY_READ_MS = 45_000;

/**
 * The reader of the repos the open waits name (`owner/name`, or an owner's repos, `owner/*`: the first 100 `gh repo
 * list` gives, listed once an hour): each repo's newest 100 events, asked with the last good answer's ETag and no sooner
 * than GitHub's poll interval after its last answer, so a repo with nothing new gives none and costs nothing; at most
 * `ACTIVITY_REPOS_MAX` repos and `ACTIVITY_READ_MS` a read, the longest unasked first (a failed ask counts as asked, so
 * it waits its turn), the rest on the next reads. Its ETags and owners' lists live in this process only. A repo or owner
 * that fails is logged and asked again later; a read where every ask failed throws.
 * ponytail: GitHub says its events can lag 30 s to 6 h; per-kind feeds (issues, comments, each pull request's reviews)
 * if a wait ever needs them sooner. More than 100 events in a repo between two reads drop the oldest.
 */
export function githubActivityReader({
  readMs = ACTIVITY_READ_MS,
  run = exec,
}: {
  readMs?: number;
  run?: typeof exec;
} = {}) {
  const owners = new Map<
    string,
    { at: number; repos: string[]; tried: number }
  >();
  const asked = new Map<string, { etag?: string; next: number }>();
  /** When each ask of a repo's events in the last minute was made, oldest first. */
  const asks: number[] = [];
  const listOwner = async (owner: string, timeout: number) =>
    (
      await ghOut(
        run,
        [
          "repo",
          "list",
          owner,
          "--no-archived",
          "--limit",
          "100",
          "--json",
          "nameWithOwner",
          "--jq",
          ".[].nameWithOwner",
        ],
        timeout
      )
    )
      .split("\n")
      .filter(Boolean)
      .map((r) => r.toLowerCase());
  const askRepo = async (repo: string, timeout: number) => {
    const etag = asked.get(repo)?.etag;
    const r = await gh(
      run,
      [
        "api",
        "-i",
        ...(etag ? ["-H", `If-None-Match: ${etag}`] : []),
        `repos/${repo}/events?per_page=100`,
      ],
      undefined,
      timeout
    );
    const answer = parseHttp(r);
    const isAnswer =
      !r.killed &&
      ((answer.status === 200 && r.code === 0) || answer.status === 304);
    if (!isAnswer) {
      throw new Error(
        `${repo}: ${answer.status && !r.killed ? `HTTP ${answer.status}` : "gh didn't answer"}`
      );
    }
    // Decoded before its ETag is kept: a cut answer is asked again with the last good one.
    const events =
      answer.status === 304
        ? []
        : (JSON.parse(answer.body) as RepoEvent[]).flatMap(activityOf);
    const every = Math.max(
      ACTIVITY_EVERY_S,
      Number(answer.headers.get("x-poll-interval")) || 0
    );
    return { etag: answer.headers.get("etag") ?? etag, events, every };
  };
  /** Whether an owner's list is due: never listed, an hour old, or a failed list a minute on. */
  const isListDue = (owner: string, now: number) => {
    const known = owners.get(owner);
    return !known || now - known.at >= OWNER_REPOS_FOR;
  };
  /**
   * An owner's repos listed again, its last list kept on a failure (asked again a minute on). Only an ask of a repo's
   * events counts as GitHub answering (`answered`): a list alone says nothing of the repos.
   */
  const listInTurn = async (owner: string, p: ReadPass) => {
    p.calls += 1;
    try {
      const listed = await listOwner(owner, timeoutOf(p));
      owners.set(owner, { at: p.at(), repos: listed, tried: p.at() });
    } catch (e) {
      p.failure(`${owner}/*: ${(e as Error).message}`);
      owners.set(owner, {
        at: p.at() - OWNER_REPOS_FOR + ACTIVITY_EVERY_S * 1000,
        repos: owners.get(owner)?.repos ?? [],
        tried: p.at(),
      });
    }
  };
  /** A repo's new activity; a failed ask keeps its last good ETag and waits its turn like an answered one. */
  const askInTurn = async (repo: string, p: ReadPass) => {
    p.calls += 1;
    const etag = asked.get(repo)?.etag;
    try {
      const a = await askRepo(repo, timeoutOf(p));
      asked.set(repo, { etag: a.etag, next: p.at() + a.every * 1000 });
      p.answered += 1;
      return a.events;
    } catch (e) {
      asked.set(repo, { etag, next: p.at() + ACTIVITY_EVERY_S * 1000 });
      p.failure((e as Error).message);
      return [];
    }
  };
  /** The due ones of `repos`, the longest unasked first, asked while the read has time and the last minute's asks are under the cap. */
  const askDue = async (repos: string[], now: number, p: ReadPass) => {
    const nextOf = (repo: string) => asked.get(repo)?.next ?? 0;
    const read: GithubActivity[] = [];
    for (const repo of repos
      .filter((r) => nextOf(r) <= now)
      .toSorted((a, b) => nextOf(a) - nextOf(b))) {
      const minuteAgo = p.at() - MIN;
      while ((asks[0] ?? minuteAgo) < minuteAgo) {
        asks.shift();
      }
      if (p.left() <= 0 || asks.length >= ACTIVITY_REPOS_MAX) {
        break;
      }
      asks.push(p.at());
      // biome-ignore lint/performance/noAwaitInLoops: one gh at a time, within the read's time
      read.push(...(await askInTurn(repo, p)));
    }
    return read;
  };
  /** The last read's failure while no ask has answered since: a read that asks nothing keeps saying it. */
  let outage: Error | undefined;
  return async (named: string[], now: number) => {
    const p = readPassOf(now, readMs);
    const wanted = [...new Set(named.map((n) => n.toLowerCase()))];
    const ownersNamed = wanted
      .filter((n) => n.endsWith("/*"))
      .map((n) => n.slice(0, -2));
    // At most one owner listed a read, the one tried longest ago: a slow or failing owner holds up no repo for more
    // than one `gh` call.
    const [toList] = ownersNamed
      .filter((o) => isListDue(o, now))
      .toSorted(
        (a, b) => (owners.get(a)?.tried ?? 0) - (owners.get(b)?.tried ?? 0)
      );
    if (toList) {
      await listInTurn(toList, p);
    }
    // One rotation over every repo named outright or listed under a named owner: the longest unasked first.
    const repos = new Set([
      ...wanted.filter((n) => !n.endsWith("/*")),
      ...ownersNamed.flatMap((o) => owners.get(o)?.repos ?? []),
    ]);
    const read = await askDue([...repos], now, p);
    // An answer, or a read whose every call went through (an owner listed with no repos), ends an outage.
    if (p.answered > 0 || (p.calls > 0 && p.failed.length === 0)) {
      outage = undefined;
    } else if (p.failed.length > 0) {
      outage = new Error(p.failed.join("; "));
    }
    if (outage && p.answered === 0) {
      throw outage;
    }
    return read;
  };
}

/** One read's time and outcomes: what is left of its time, the instant now by the time spent, its failures (logged) and answers. */
interface ReadPass {
  answered: number;
  at: () => number;
  /** How many `gh` calls it made, answered or not. */
  calls: number;
  failed: string[];
  failure: (error: string) => void;
  left: () => number;
}

/** A `gh` call's timeout within what is left of the read, whole milliseconds. */
const timeoutOf = (p: ReadPass) =>
  Math.max(1, Math.floor(Math.min(GH_MS, p.left())));

const readPassOf = (now: number, readMs: number): ReadPass => {
  const started = performance.now();
  const failed: string[] = [];
  return {
    answered: 0,
    at: () => now + (performance.now() - started),
    calls: 0,
    failed,
    failure: (error) => {
      failed.push(error);
      log("source.read", {
        error,
        ok: false,
        source: "github",
        what: "activity",
      });
    },
    left: () => readMs - (performance.now() - started),
  };
};
