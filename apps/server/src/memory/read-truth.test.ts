import { describe, expect, test } from "bun:test";
import { cpSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOG_DIR } from "../core/log";
import {
  FIXTURES,
  LIFE_CODE_DIR,
  LIFE_STATE_DIR,
  OWNER_DATA_DIR,
  real,
} from "../core/paths";
import { git } from "../core/proc";
import { SETTINGS } from "../core/settings";
import { Chat, Organization, Person } from "../records/truth";
import { WATCH } from "../sources/lifelog";
import { commitMemory, OUT } from "./memory-files";
import {
  goalProjects,
  integrity,
  isDirectoryNew,
  loadTruth,
  projectPeopleAndChatsOf,
  readMe,
  type Truth,
} from "./read-truth";

const person = (id: string, whatsapp: string[] = []): Person => ({
  aliases: [],
  handles: { email: [], phone: [], whatsapp },
  id,
  name: id,
  projects: [],
});

const chat = (over: Partial<Chat>): Chat => ({
  id: "!a:matrix.local",
  name: "A",
  ...over,
});

const truth = (over: Partial<Truth>): Truth => ({
  areas: [],
  chats: [chat({})],
  me: readMe("# Me\n\nJean.\n\n## Goals\n1. Be well."),
  organizations: [],
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
      "chat !a:matrix.local is listed twice"
    );
  });

  test("a chat's id is a room id or a WhatsApp id, and never another chat's whatsapp", () => {
    const ok = (id: string) => Chat.safeParse({ id, name: "A" }).success;
    expect(
      ["!a:matrix.local", "1204@g.us", "10000000001@s.whatsapp.net"].map(ok)
    ).toEqual([true, true, true]);
    expect(["shop group", "iMessage;+;chat1"].map(ok)).toEqual([false, false]);
    expect(
      integrity(
        truth({
          chats: [chat({ whatsapp: "1204@g.us" }), chat({ id: "1204@g.us" })],
        })
      )
    ).toContain("chat !a:matrix.local's whatsapp is another chat's id");
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
        projects: [project("lifelog", { chats: ["!ghost:matrix.local"] })],
      })
    );
    expect(issues).toContain("project lifelog names unknown area work");
    expect(issues).toContain(
      "project lifelog names unknown chat !ghost:matrix.local"
    );
  });

  test("me.md's goals are optional, and name projects that exist", () => {
    expect(integrity(truth({ me: readMe("# Me\n\nJean.") }))).toEqual([]);
    const me = readMe("# Me\n\nJean.\n\n## Goals\n1. Be free. (`ghost`)");
    expect(integrity(truth({ me }))).toEqual([
      "a goal in me.md names unknown project ghost",
    ]);
  });

  test("people and organizations share one id space and their handles; an organization names people and projects that exist; a project may name it", () => {
    const org = (id: string, over: object = {}) =>
      Organization.parse({ id, name: id, ...over });
    const issues = integrity(
      truth({
        organizations: [
          org("dad"),
          org("shop", {
            handles: { whatsapp: ["+33600000000"] },
            people: [
              { id: "dad", role: "owner", until: 2024 },
              { id: "ghost", role: "clerk" },
            ],
            projects: ["nowhere"],
          }),
        ],
        people: [person("me"), person("dad", ["+33600000000"])],
      })
    );
    expect(issues).toEqual([
      "person dad is listed twice",
      "+33600000000 belongs to both dad and shop",
      "organization shop names unknown person ghost",
      "organization shop names unknown project nowhere",
    ]);
    expect(
      integrity(
        truth({
          areas: [{ id: "work", name: "Work" }],
          organizations: [org("shop")],
          projects: [project("bakery", { people: ["shop"] })],
        })
      )
    ).toEqual([]);
    // `until` is a year or a day; a domain is a host name.
    expect(
      [2024, "2024-05-01", "May"].map(
        (until) =>
          Organization.safeParse({
            id: "shop",
            name: "Shop",
            people: [{ id: "dad", role: "owner", until }],
          }).success
      )
    ).toEqual([true, true, false]);
    expect(
      Organization.safeParse({ domains: ["@shop"], id: "shop", name: "Shop" })
        .success
    ).toBe(false);
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
  // This run's own copy of apps/server/src/test-data, outside any repo: a test can never commit.
  expect(OWNER_DATA_DIR.startsWith(real(tmpdir()))).toBe(true);
  expect(readdirSync(join(OWNER_DATA_DIR, "truth")).sort()).toEqual(
    readdirSync(join(FIXTURES, "truth")).sort()
  );
  expect(integrity(await loadTruth())).toEqual([]);
  expect((await loadTruth()).organizations.map((o) => o.id)).toEqual([
    "test-bakery",
  ]);
  // A directory with no organizations.yaml has none.
  rmSync(join(OWNER_DATA_DIR, "truth", "organizations.yaml"));
  try {
    expect((await loadTruth()).organizations).toEqual([]);
  } finally {
    cpSync(
      join(FIXTURES, "truth", "organizations.yaml"),
      join(OWNER_DATA_DIR, "truth", "organizations.yaml")
    );
  }
  expect(() => commitMemory(["memory"], "t")).toThrow("not a repo of its own");
  // His data is never pushed: a data repo with a remote is refused before anything is staged.
  git(OWNER_DATA_DIR, ["init", "-q"]);
  git(OWNER_DATA_DIR, [
    "remote",
    "add",
    "origin",
    "https://example.test/x.git",
  ]);
  try {
    expect(() => commitMemory(["memory"], "t")).toThrow("never pushed");
  } finally {
    rmSync(join(OWNER_DATA_DIR, ".git"), { force: true, recursive: true });
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
  for (const path of [LIFE_STATE_DIR, SETTINGS, LOG_DIR, OUT, WATCH]) {
    expect(path.startsWith(OWNER_DATA_DIR)).toBe(true);
    expect(path.startsWith(LIFE_CODE_DIR)).toBe(false);
  }
});

test("his data and Life's state are real paths: nothing copies or removes through a link", () => {
  expect(OWNER_DATA_DIR).toBe(real(OWNER_DATA_DIR));
  expect(LIFE_STATE_DIR).toBe(real(LIFE_STATE_DIR));
});

test("his goals' projects, in his order", () => {
  expect(
    goalProjects(
      "1. Be free (`lynx`, `life`).\n2. Earn from `shop`\n   and more."
    )
  ).toEqual([["lynx", "life"], ["shop"]]);
});

test("me.md's what Life may keep is the block under its heading; absent or empty, there is no limit", () => {
  const me = readMe(
    "# Me\n\nJean.\n\n## What Life may keep\nNothing about my health.\nNo drugs.\n\n## Goals\n1. Be free."
  );
  expect(me.mayKeep).toBe("Nothing about my health.\nNo drugs.");
  expect(me.goals).toBe("1. Be free.");
  expect(
    readMe("# Me\n\nJean.\n\n## Goals\n1. Be free.").mayKeep
  ).toBeUndefined();
  expect(readMe("# Me\n\n## What Life may keep\n\n").mayKeep).toBeUndefined();
});

test("a directory is new while it holds only him and no goals", () => {
  const me = person("me");
  const plain = readMe("# Me\n\nA test.");
  expect(isDirectoryNew({ me: plain, people: [me] })).toBe(true);
  expect(
    isDirectoryNew({ me: readMe("# Me\n\n## Goals\n1. Ship."), people: [me] })
  ).toBe(false);
  expect(isDirectoryNew({ me: plain, people: [me, person("ada")] })).toBe(
    false
  );
});

describe("projectPeopleAndChatsOf", () => {
  const project = (over: Partial<Truth["projects"][number]>) => ({
    area: "shop",
    chats: [],
    deadlines: [],
    id: "shop",
    name: "Shop",
    notes: "",
    people: [],
    repos: [],
    schemaVersion: 1 as const,
    status: "active" as const,
    ...over,
  });

  test("people from both directions in order, handles per platform, chats by their key", () => {
    const ana = { ...person("ana", ["+10000000001"]), projects: ["shop"] };
    const t = truth({
      chats: [
        chat({ id: "!g:example.test", whatsapp: "1203@g.us" }),
        chat({ id: "!r:example.test" }),
        chat({ id: "1204@g.us" }),
      ],
      people: [person("me"), person("bob"), ana, person("cy")],
      projects: [
        project({
          chats: [
            "!r:example.test",
            "!none:example.test",
            "!g:example.test",
            "1204@g.us",
          ],
          people: ["cy", "bob", "ghost"],
        }),
      ],
    });
    const held = projectPeopleAndChatsOf(t, "shop");
    expect(held?.people.map((p) => p.id)).toEqual(["cy", "bob", "ana"]);
    expect(held?.people[2]?.handles).toEqual([
      { platform: "whatsapp", values: ["+10000000001"] },
    ]);
    expect(held?.chats).toEqual([
      { isSure: false, key: "!r:example.test", name: "A" },
      { isSure: true, key: "1203@g.us", name: "A" },
      { isSure: true, key: "1204@g.us", name: "A" },
    ]);
    expect(projectPeopleAndChatsOf(t, "other")).toBeNull();
  });
});
