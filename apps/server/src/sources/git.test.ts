import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Person } from "../schema";
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
  const since = new Date(Date.now() - 3_600_000);
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
