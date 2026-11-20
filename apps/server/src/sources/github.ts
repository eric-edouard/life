import { clock, iso, MIN } from "../core/clock";
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
import { takesProblemOf } from "./chat-takes";
import type { ChatTakes, Outgoing, SendPath } from "./contract";

// The GitHub source: the issues and issue comments of the repos he lists (`githubRepos`), one chat per issue
// (`owner/name#12`), copied into `archive/github.sqlite` (each version kept, like a bridge's) and read from there. The
// only place Life runs `gh` (`scripts/imports.test.ts`). Pull requests and their comments are left out.

type Run = Awaited<ReturnType<typeof exec>>;

/** How often the copier asks GitHub: 2 calls a repo each time, well under GitHub's 5,000 an hour. */
const POLL_MS = 20_000;
/** A failing GitHub is asked again after a pause that doubles up to this. */
const PAUSE_MAX = 15 * MIN;
const GH_MS = 15_000;
const SEND_MS = 30_000;
/** What an issue takes besides text: nothing (an @login in the text pings). */
const TAKES: ChatTakes = {
  file: false,
  mentions: false,
  reaction: false,
  reply: false,
};
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
async function ghOut(run: typeof exec, args: string[]) {
  const r = await gh(run, args);
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
      if (takesProblemOf(d, TAKES)) {
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
    takes: () => TAKES,
  };
}
