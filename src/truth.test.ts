import { describe, expect, test } from "bun:test";
import { readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_DIR } from "./log";
import { OUT } from "./memory/ledger";
import { commitMemory } from "./memory/run";
import { git } from "./proc";
import { type Chat, Person } from "./schema";
import { SETTINGS } from "./settings";
import { WATCH } from "./sources/lifelog";
import {
  DATA,
  FIXTURES,
  integrity,
  loadTruth,
  ROOT,
  readMe,
  STATE,
  type Truth,
} from "./truth";

const person = (id: string, whatsapp: string[] = []): Person => ({
  aliases: [],
  handles: { email: [], phone: [], whatsapp },
  id,
  name: id,
  projects: [],
});

const chat = (over: Partial<Chat>): Chat => ({
  id: "!a:beeper.local",
  name: "A",
  ...over,
});

const truth = (over: Partial<Truth>): Truth => ({
  areas: [],
  chats: [chat({})],
  me: readMe("# Me\n\nJean.\n\n## Goals\n1. Be well."),
  people: [person("me"), person("dad")],
  projects: [],
  ...over,
});

describe("integrity", () => {
  test("a consistent map has no issues", () => {
    expect(integrity(truth({}))).toEqual([]);
  });

  test("one phone number on two people is refused", () => {
    const issues = integrity(
      truth({
        people: [
          person("me"),
          person("dad", ["+33600000000"]),
          person("hans", ["+33600000000"]),
        ],
      })
    );
    expect(issues).toContain("+33600000000 belongs to both dad and hans");
  });

  test("a chat listed twice is refused", () => {
    expect(integrity(truth({ chats: [chat({}), chat({})] }))).toContain(
      "chat !a:beeper.local is listed twice"
    );
  });

  test("an area listed twice is refused", () => {
    const issues = integrity(
      truth({
        areas: [
          { id: "shop", name: "Shop" },
          { id: "shop", name: "Shop again" },
        ],
      })
    );
    expect(issues).toContain("area shop is listed twice");
  });

  type P = Truth["projects"][number];
  const project = (id: string, over: Partial<P> = {}): P => ({
    area: "work",
    chats: [],
    deadlines: [],
    id,
    name: id,
    notes: "",
    people: [],
    repos: [],
    schemaVersion: 1,
    status: "active",
    ...over,
  });

  test("a project in an area that is not listed, or with a chat that is not, is refused", () => {
    const issues = integrity(
      truth({
        projects: [project("lifelog", { chats: ["!ghost:beeper.local"] })],
      })
    );
    expect(issues).toContain("project lifelog names unknown area work");
    expect(issues).toContain(
      "project lifelog names unknown chat !ghost:beeper.local"
    );
  });

  test("me.md's goals are optional, and name projects that exist", () => {
    expect(integrity(truth({ me: readMe("# Me\n\nJean.") }))).toEqual([]);
    const me = readMe("# Me\n\nJean.\n\n## Goals\n1. Be free. (`ghost`)");
    expect(integrity(truth({ me }))).toEqual([
      "a goal in me.md names unknown project ghost",
    ]);
  });

  test("a repo in two projects is refused", () => {
    const repos = ["bakery-hq"];
    const issues = integrity(
      truth({
        areas: [{ id: "work", name: "Work" }],
        projects: [project("bakery", { repos }), project("lifelog", { repos })],
      })
    );
    expect(issues).toContain(
      "repo bakery-hq belongs to both bakery and lifelog"
    );
  });
});

test("truth/me.md gives who he is (its first paragraph) and his goals", () => {
  const me = readMe(
    "# Me\n\nA citizen of two countries.\n\n## Goals\n1. Be free."
  );
  expect(me.about).toBe("A citizen of two countries.");
  expect(me.goals).toBe("1. Be free.");
});

test("tests read made-up data, and it is a consistent map", async () => {
  // This run's own copy of src/test-data, outside any repo: a test can never commit.
  expect(DATA.startsWith(tmpdir())).toBe(true);
  expect(readdirSync(join(DATA, "truth")).sort()).toEqual(
    readdirSync(join(FIXTURES, "truth")).sort()
  );
  expect(integrity(await loadTruth())).toEqual([]);
  expect(() => commitMemory(["memory"], "t")).toThrow("not a repo of its own");
  // His data is never pushed: a data repo with a remote is refused before anything is staged.
  git(DATA, ["init", "-q"]);
  git(DATA, ["remote", "add", "origin", "https://example.test/x.git"]);
  try {
    expect(() => commitMemory(["memory"], "t")).toThrow("never pushed");
  } finally {
    rmSync(join(DATA, ".git"), { force: true, recursive: true });
  }
});

test("me.md's goals are the block under Goals; its first paragraph is who he is", () => {
  const me = readMe(
    "# Me\n\nJean, in Oslo.\nTwo lines.\n\n## Goals\n1. Be free.\n2. Be well.\n\n## Accounts\n- x\n"
  );
  expect(me.about).toBe("Jean, in Oslo. Two lines.");
  expect(me.goals).toBe("1. Be free.\n2. Be well.");
});

test("a birthday is --MM-DD or YYYY-MM-DD, and a real date", () => {
  const ok = (birthday: string) =>
    Person.safeParse({ birthday, id: "ana", name: "Ana" }).success;
  expect([ok("--02-29"), ok("1993-11-12")]).toEqual([true, true]);
  expect([ok("--02-30"), ok("11-12"), ok("1993-13-01")]).toEqual([
    false,
    false,
    false,
  ]);
});

test("a test run's state is all in its copy of the data, never the checkout's derived/", () => {
  for (const path of [STATE, SETTINGS, LOG_DIR, OUT, WATCH]) {
    expect(path.startsWith(DATA)).toBe(true);
    expect(path.startsWith(ROOT)).toBe(false);
  }
});
