import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import { git } from "../core/proc";
import { loadTruth } from "../memory/read-truth";
import {
  addDirectoryEntryByHisWord,
  addOrganizationPersonByHisWord,
  changeDirectoryEntry,
  DirectoryEntryChange,
} from "./change-directory-entry";

// The run's own copy of the made-up data (OWNER_DATA_DIR): backed up, made a repo, put back.
const TRUTH = join(OWNER_DATA_DIR, "truth");
const BACKUP = `${TRUTH}.backup`;
const file = (p: string) => readFileSync(join(TRUTH, p), "utf8");
const log = () => git(OWNER_DATA_DIR, ["log", "--format=%B"]).stdout.toString();

beforeAll(() => {
  cpSync(TRUTH, BACKUP, { recursive: true });
  git(OWNER_DATA_DIR, ["init", "-q"]);
  git(OWNER_DATA_DIR, ["config", "user.name", "t"]);
  git(OWNER_DATA_DIR, ["config", "user.email", "t@example.test"]);
  git(OWNER_DATA_DIR, ["add", "truth"]);
  git(OWNER_DATA_DIR, ["commit", "-q", "-m", "start"]);
});
afterAll(() => {
  rmSync(join(OWNER_DATA_DIR, ".git"), { force: true, recursive: true });
  rmSync(TRUTH, { force: true, recursive: true });
  cpSync(BACKUP, TRUTH, { recursive: true });
  rmSync(BACKUP, { force: true, recursive: true });
});

const said = "Add it, please.";

test("an invalid change is refused and truth/ is left as it was", async () => {
  const before = file("people.yaml");
  await expect(
    changeDirectoryEntry({
      action: "add",
      area: "nowhere",
      kind: "project",
      name: "Shop",
      said,
    })
  ).rejects.toThrow("unknown area nowhere");
  await expect(
    changeDirectoryEntry({
      action: "add",
      handles: { email: ["owner@example.com"] },
      kind: "person",
      name: "Dup",
      said,
    })
  ).rejects.toThrow("belongs to both");
  await expect(
    changeDirectoryEntry({
      action: "add",
      kind: "goal",
      said,
      text: "Be bold. (`ghost`)",
    })
  ).rejects.toThrow("unknown project ghost");
  expect(file("people.yaml")).toBe(before);
  expect(existsSync(join(TRUTH, "projects", "shop.md"))).toBe(false);
});

test("valid changes are written one entry at a time, commented lines kept, and committed with his words", async () => {
  writeFileSync(join(TRUTH, "people.yaml"), `${file("people.yaml")}# kept\n`);
  await changeDirectoryEntry({
    action: "add",
    kind: "area",
    name: "Work",
    said,
  });
  await changeDirectoryEntry({
    action: "add",
    area: "work",
    kind: "project",
    name: "Shop",
    repos: ["shop"],
    said,
  });
  await changeDirectoryEntry({
    action: "add",
    kind: "person",
    name: "Léa Martin",
    relation: "sister",
    said,
  });
  await changeDirectoryEntry({
    action: "edit",
    handles: { email: ["lea@example.com"] },
    id: "lea-martin",
    kind: "person",
    said,
  });
  await changeDirectoryEntry({
    action: "add",
    kind: "goal",
    said,
    text: "Grow the shop. (`shop`)",
  });
  await changeDirectoryEntry({
    action: "edit",
    kind: "goal",
    number: 1,
    said,
    text: "Be very well.",
  });
  await changeDirectoryEntry({
    action: "edit",
    kind: "may_keep",
    said,
    text: "Nothing about my health.",
  });
  expect(file("areas.yaml")).toContain('{"id":"work","name":"Work"}');
  expect(file("projects/shop.md")).toContain('repos: ["shop"]');
  expect(file("people.yaml")).toContain("# kept");
  expect(file("people.yaml")).toContain("lea@example.com");
  expect(file("me.md")).toContain(
    "1. Be very well.\n2. Grow the shop. (`shop`)"
  );
  expect(file("me.md")).toContain(
    "## What Life may keep\nNothing about my health."
  );
  expect(log()).toContain("Truth, by his words: edit person lea-martin");
  expect(log()).toContain(said);
});

// A project's status by his tap (20 Nov 2026): Parked, then Undo back to what it was; only its status line changes.
test("a project's status edit rewrites its status line alone, and back again", async () => {
  await changeDirectoryEntry({
    action: "add",
    area: "work",
    kind: "project",
    name: "Kiosk",
    said,
    status: "waiting",
  });
  writeFileSync(
    join(TRUTH, "projects/kiosk.md"),
    `${file("projects/kiosk.md")}\nNotes he wrote.\n`
  );
  const before = file("projects/kiosk.md");
  const status = (to: "parked" | "waiting") =>
    changeDirectoryEntry({
      action: "edit",
      id: "kiosk",
      kind: "project",
      said: "I dropped this whole project",
      status: to,
    });
  expect(await status("parked")).toBe("Done: edit project kiosk.");
  expect(file("projects/kiosk.md")).toBe(
    before.replace("status: waiting", 'status: "parked"')
  );
  expect(
    (await loadTruth()).projects.find((p) => p.id === "kiosk")?.status
  ).toBe("parked");
  await status("waiting");
  expect(file("projects/kiosk.md")).toBe(
    before.replace("status: waiting", 'status: "waiting"')
  );
});

// A one-off project (28 Nov 2026): its goal is his ask, word for word, within `said`; it ends done or dropped.
test("a one-off project keeps his ask as its goal, refuses words he did not say, and ends dropped", async () => {
  const ask = "Sort out my old travel photos into albums";
  await changeDirectoryEntry({
    action: "add",
    id: "trips",
    kind: "area",
    name: "Trips",
    said: "Add a Trips area",
  });
  await expect(
    changeDirectoryEntry({
      action: "add",
      area: "trips",
      goal: "Delete every photo",
      kind: "project",
      name: "Travel photos",
      said: ask,
    })
  ).rejects.toThrow("word for word");
  await changeDirectoryEntry({
    action: "add",
    area: "trips",
    goal: ask,
    kind: "project",
    name: "Travel photos",
    said: `Please: ${ask}.`,
  });
  await changeDirectoryEntry({
    action: "edit",
    id: "travel-photos",
    kind: "project",
    said: "Drop the photos project",
    status: "dropped",
  });
  const p = (await loadTruth()).projects.find((x) => x.id === "travel-photos");
  expect([p?.goal, p?.status]).toEqual([ask, "dropped"]);
});

test("refused: a goal over two lines, a heading in the text, a name with no id", async () => {
  const before = file("me.md");
  const text = (t: string, kind: "goal" | "may_keep") =>
    changeDirectoryEntry({ action: "add", kind, said, text: t });
  await expect(text("One.\n2. Two.", "goal")).rejects.toThrow("one line");
  await expect(text("## Goals", "goal")).rejects.toThrow("start with `#`");
  await expect(text("Fine.\n## Goals\nx", "may_keep")).rejects.toThrow(
    "start with `#`"
  );
  await expect(
    changeDirectoryEntry({ action: "add", kind: "area", name: "健康", said })
  ).rejects.toThrow("give an `id`");
  expect(file("me.md")).toBe(before);
});

test("calls at once each land, `$&` in his words stays as written, and a busy git still answers done", async () => {
  await Promise.all(
    ["alpha", "beta", "gamma"].map((name) =>
      changeDirectoryEntry({ action: "add", kind: "area", name, said })
    )
  );
  for (const id of ["alpha", "beta", "gamma"]) {
    expect(file("areas.yaml")).toContain(`"id":"${id}"`);
  }
  await changeDirectoryEntry({
    action: "add",
    kind: "may_keep",
    said,
    text: "Never keep $& or $1.",
  });
  expect(file("me.md")).toContain("Never keep $& or $1.");
  // The night holds git's index: the write stands, the answer is still done, never a failure.
  writeFileSync(join(OWNER_DATA_DIR, ".git", "index.lock"), "");
  try {
    expect(
      await changeDirectoryEntry({
        action: "add",
        kind: "area",
        name: "Delta",
        said,
      })
    ).toStartWith("Done");
  } finally {
    rmSync(join(OWNER_DATA_DIR, ".git", "index.lock"), { force: true });
  }
  expect(file("areas.yaml")).toContain('"id":"delta"');
});

test("a new person he names answering a check is added with their name's id, numbered past one taken, and committed with his tap (life#721)", async () => {
  const tap = (n: string) =>
    addDirectoryEntryByHisWord("person", n, `New person: ${n}`);
  expect(await tap("Léa Fontaine")).toBe("person:lea-fontaine");
  expect(await tap("Léa Fontaine")).toBe("person:lea-fontaine-2");
  expect(await tap("มะลิ")).toBe("person:person");
  expect(file("people.yaml")).toContain("มะลิ");
  // A name with a slash, as typed on a card (his report of 22 Nov).
  expect(await tap("Zed/Zeda")).toBe("person:zed-zeda");
  expect(log()).toContain("New person: Léa Fontaine");
  // An organization's id is taken too: one id space.
  expect(await tap("Test Bakery")).toBe("person:test-bakery-2");
});

test("an organization is added and edited in full; its file is made on the first add; a clash with a person's id is refused", async () => {
  rmSync(join(TRUTH, "organizations.yaml"));
  expect(
    await addDirectoryEntryByHisWord(
      "organization",
      "Test Garage",
      "New organization: Test Garage",
      { relation: "fixes his car" }
    )
  ).toBe("person:test-garage");
  await changeDirectoryEntry({
    action: "edit",
    aliases: ["The Garage"],
    domains: ["garage.example"],
    handles: { email: ["desk@garage.example"] },
    id: "test-garage",
    kind: "organization",
    people: [{ id: "test-ana", role: "mechanic" }],
    said,
  });
  // His word on one there replaces that one's role, and `until` says she left.
  await changeDirectoryEntry({
    action: "edit",
    id: "test-garage",
    kind: "organization",
    people: [{ id: "test-ana", role: "manager", until: 2025 }],
    said,
  });
  const [garage] = (await loadTruth()).organizations;
  expect(garage).toEqual({
    aliases: ["The Garage"],
    domains: ["garage.example"],
    handles: { email: ["desk@garage.example"], phone: [], whatsapp: [] },
    id: "test-garage",
    name: "Test Garage",
    people: [{ id: "test-ana", role: "manager", until: 2025 }],
    projects: [],
    relation: "fixes his car",
  });
  expect(log()).toContain("Truth, by his words: edit organization test-garage");
  const before = file("organizations.yaml");
  await expect(
    changeDirectoryEntry({
      action: "add",
      id: "test-ana",
      kind: "organization",
      name: "Ana Inc",
      said,
    })
  ).rejects.toThrow("person test-ana is listed twice");
  await expect(
    changeDirectoryEntry({
      action: "edit",
      id: "test-garage",
      kind: "organization",
      people: [{ id: "nobody", role: "ghost" }],
      said,
    })
  ).rejects.toThrow("organization test-garage names unknown person nobody");
  expect(file("organizations.yaml")).toBe(before);
});

test("his picture pick on a person and an organization, through the one schema the connector takes; a source that does not exist is refused, and so is a project's member with a role", async () => {
  await changeDirectoryEntry(
    DirectoryEntryChange.parse({
      action: "edit",
      id: "test-ana",
      kind: "person",
      pictureFrom: "whatsapp",
      said: "Use her WhatsApp picture.",
    })
  );
  await changeDirectoryEntry(
    DirectoryEntryChange.parse({
      action: "edit",
      id: "test-garage",
      kind: "organization",
      pictureFrom: "none",
      said: "No picture for the garage.",
    })
  );
  const truth = await loadTruth();
  expect(truth.people.find((p) => p.id === "test-ana")?.pictureFrom).toBe(
    "whatsapp"
  );
  expect(truth.organizations.find((o) => o.id === "test-garage")).toMatchObject(
    { pictureFrom: "none" }
  );
  expect(
    DirectoryEntryChange.safeParse({
      action: "edit",
      id: "test-ana",
      kind: "person",
      pictureFrom: "myspace",
      said,
    }).success
  ).toBe(false);
  await expect(
    changeDirectoryEntry({
      action: "add",
      area: "home",
      kind: "project",
      name: "Shed",
      people: [{ id: "test-ana", role: "builder" }],
      said,
    })
  ).rejects.toThrow("a project's `people` are ids");
});

test("his Yes on an at organization card adds that one member with the card's role, kept beside the others and committed with his tap; someone there already is refused, their role kept (life#874)", async () => {
  const yes = () =>
    addOrganizationPersonByHisWord(
      "person:test-garage",
      "person:me",
      "Owner",
      '"Yes" to "Is Test Owner at Test Garage as Owner?"'
    );
  expect(await yes()).toStartWith("Done");
  const garage = (await loadTruth()).organizations.find(
    (o) => o.id === "test-garage"
  );
  expect(garage?.people).toEqual([
    { id: "test-ana", role: "manager", until: 2025 },
    { id: "me", role: "Owner" },
  ]);
  expect(log()).toContain('"Yes" to "Is Test Owner at Test Garage as Owner?"');
  await expect(yes()).rejects.toThrow("me is already at test-garage");
});

test("an edit of one handle keeps his comments and the rest of the file as written", async () => {
  const id = "00000000-0000-8000-8000-0000000000b1";
  const bea = [
    "  - id: test-bea",
    "    name: Test Bea",
    "    # Owner, 1 Nov: met at the bakery.",
    "    relation: friend",
    "    aliases: [Bea, Béa]",
    "    handles:",
    "      # Owner, 2 Nov: her work address.",
    '      email: ["bea@example.test"]',
  ];
  writeFileSync(
    join(TRUTH, "people.yaml"),
    `${file("people.yaml").trimEnd()}\n${bea.join("\n")}\n  # the last line\n`
  );
  const before = file("people.yaml");
  await changeDirectoryEntry({
    action: "edit",
    handles: { voice: id },
    id: "test-bea",
    kind: "person",
    said: "Her voice is this one",
  });
  const after = file("people.yaml");
  expect(after).toBe(
    before.replace(
      `      # Owner, 2 Nov: her work address.\n      email: ["bea@example.test"]\n`,
      `      # Owner, 2 Nov: her work address.\n      email: ["bea@example.test"]\n      voice: ${id}\n`
    )
  );
  expect(
    (await loadTruth()).people.find((p) => p.id === "test-bea")?.handles.voice
  ).toBe(id);
});
