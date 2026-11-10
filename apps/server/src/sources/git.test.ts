import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOUR } from "../core/clock";
import { Person } from "../records/truth";
import { listRepos, parseLog, readGit } from "./git";

const RS = "\x1e";
const US = "\x1f";
const commit = (
  sha: string,
  at: string,
  email: string,
  subject: string,
  stat: string[] = []
) =>
  `${RS}${sha}${US}${at}${US}${email}${US}Name${US}${subject}\n\n${stat.join("\n")}\n`;
const SINCE = new Date("2026-10-08T00:00:00+02:00");
// His commits are by any of his emails in truth, or his name.
const me = Person.parse({
  handles: { email: ["old@example.com", "owner@example.com"] },
  id: "me",
  name: "Jean Dupont",
});

test("a log gives one event per commit: lines without lockfiles, binaries and generated-size files, each sha once, nothing authored before since", () => {
  const out = [
    commit("a1", "2026-10-09T10:00:00+02:00", "owner@example.com", "Add map", [
      "10\t2\tsrc/map.ts",
      "5000\t1\tdrizzle/meta/0001_snapshot.json",
      "900\t0\tbun.lock",
      "-\t-\tassets/logo.png",
      "3\t4\tsrc/old => src/new.ts",
    ]),
    commit("a1", "2026-10-09T10:00:00+02:00", "owner@example.com", "Add map"),
    commit("b2", "2026-10-07T23:00:00+02:00", "owner@example.com", "Too old"),
    commit("c3", "2026-10-10T09:00:00+02:00", "jerome@example.com", "Fix crop"),
    commit("d4", "2026-10-11T09:00:00+02:00", "Old@Example.com", "Old mail"),
    `${RS}e5${US}2026-10-12T09:00:00+02:00${US}x@example.com${US}JEAN DUPONT${US}Renamed\n\n`,
  ].join("");
  const events = parseLog(out, "bakery-hq", SINCE, me);
  expect(events.map((e) => e.id)).toEqual([
    "git:bakery-hq/a1",
    "git:bakery-hq/c3",
    "git:bakery-hq/d4",
    "git:bakery-hq/e5",
  ]);
  expect(events[0]).toMatchObject({
    added: 13,
    at: "2026-10-09T08:00:00.000Z",
    chat: "bakery-hq",
    fromMe: true,
    removed: 6,
    source: "git",
    text: "Add map",
  });
  expect(events[1]).toMatchObject({ fromMe: false, sender: "Name" });
  // Any of his emails in truth, in any case.
  expect(events[2]).toMatchObject({ fromMe: true, sender: "me" });
  // Or his name, in any case.
  expect(events[3]).toMatchObject({ fromMe: true, sender: "me" });
});

const as = (email: string, name: string) => ({
  ...process.env,
  GIT_AUTHOR_EMAIL: email,
  GIT_AUTHOR_NAME: name,
  GIT_COMMITTER_EMAIL: email,
  GIT_COMMITTER_NAME: name,
});

const git = (cwd: string, who: string[], ...args: string[]) => {
  const [email = "", name = ""] = who;
  const p = Bun.spawnSync(
    ["git", "-C", cwd, "-c", "commit.gpgsign=false", ...args],
    { env: as(email, name), stderr: "pipe" }
  );
  expect(p.exitCode).toBe(0);
};

test("worktrees fold into their main repo; other authors count only in mapped repos", () => {
  const root = mkdtempSync(join(tmpdir(), "life-git-"));
  const main = join(root, "photo-app");
  const [owner, jerome] = [
    ["owner@example.com", "Jean Dupont"],
    ["jerome@example.com", "Jerome"],
  ];
  const save = (dir: string, file: string, who: string[]) => {
    writeFileSync(join(dir, file), "x\n");
    git(dir, who, "add", file);
    git(dir, who, "commit", "-q", "-m", file);
  };
  git(root, owner, "init", "-q", main);
  save(main, "mine", owner);
  save(main, "theirs", jerome);
  const wt = join(root, "photo-app-wt");
  git(main, owner, "worktree", "add", "-q", "-b", "feature", wt);
  save(wt, "branch", owner);

  expect(listRepos(root).map((r) => r.key)).toEqual(["photo-app"]);
  const since = new Date(Date.now() - HOUR);
  const text = (mapped: string[]) =>
    readGit(
      since,
      new Map(mapped.map((k) => [k, { area: null, project: k }])),
      me,
      root
    )
      .map((e) => e.text)
      .sort();
  expect(text([])).toEqual(["branch", "mine"]);
  expect(text(["photo-app"])).toEqual(["branch", "mine", "theirs"]);
}, 20_000); // a dozen git runs: seconds on Windows, where a process starts slowly

test("a commit in two clones of one repo counts once: in a mapped clone first, else the first by key", () => {
  const root = mkdtempSync(join(tmpdir(), "life-git-"));
  const owner = ["owner@example.com", "Jean Dupont"];
  const [fork, template] = [
    join(root, "bakery-shop"),
    join(root, "app-template"),
  ];
  git(root, owner, "init", "-q", template);
  writeFileSync(join(template, "base"), "x\n");
  git(template, owner, "add", "base");
  git(template, owner, "commit", "-q", "-m", "base");
  git(root, owner, "clone", "-q", template, fork);
  writeFileSync(join(fork, "menu"), "x\n");
  git(fork, owner, "add", "menu");
  git(fork, owner, "commit", "-q", "-m", "menu");

  const since = new Date(Date.now() - HOUR);
  const ids = (mapped: string[]) =>
    readGit(
      since,
      new Map(mapped.map((k) => [k, { area: null, project: k }])),
      me,
      root
    )
      .map((e) => `${e.chat}:${e.text}`)
      .sort();
  expect(ids([])).toEqual(["app-template:base", "bakery-shop:menu"]);
  expect(ids(["bakery-shop"])).toEqual([
    "bakery-shop:base",
    "bakery-shop:menu",
  ]);
}, 20_000);

test("historical months use author dates even when a commit was committed the next month", () => {
  const root = mkdtempSync(join(tmpdir(), "life-git-dates-"));
  const repo = join(root, "calendar-app");
  const owner = ["owner@example.com", "Jean Dupont"];
  git(root, owner, "init", "-q", repo);
  const saved = Bun.spawnSync(
    [
      "git",
      "-C",
      repo,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--allow-empty",
      "-qm",
      "January work",
    ],
    {
      env: {
        ...as("owner@example.com", "Jean Dupont"),
        GIT_AUTHOR_DATE: "2024-01-31T12:00:00Z",
        GIT_COMMITTER_DATE: "2024-02-02T12:00:00Z",
      },
      stderr: "pipe",
    }
  );
  expect(saved.exitCode).toBe(0);
  const read = (from: string, to: string) =>
    readGit(new Date(from), new Map(), me, root, new Date(to));
  const january = read("2024-01-01", "2024-02-01");
  expect(january.map((e) => [e.text, e.at])).toEqual([
    ["January work", "2024-01-31T12:00:00.000Z"],
  ]);
  expect(read("2024-02-01", "2024-03-01")).toEqual([]);
}, 20_000);
