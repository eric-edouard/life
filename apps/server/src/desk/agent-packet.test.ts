import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, DAY, iso } from "../core/clock";
import { writeJson } from "../core/files";
import { OWNER_DATA_DIR } from "../core/paths";
import { agentOf } from "../host/desk-read";
import {
  matcherOf,
  messageMatchableOf,
  messagePayloadOf,
} from "../host/events";
import { projectSituationPath } from "../memory/situation-parts";
import { readPeople } from "../memory/who";
import { promptNameOf } from "../models/prompt-parts";
import type { SourceEvent } from "../records/source";
import { openAssignment, readPacket, register } from "./agent-actions";
import { wakeDue } from "./desk-clock";
import { type Desk, openDesk, writeWait } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";
import { matterView, on, withMatters } from "./test-desk";

// A project's agent is handed its people and chats as the directory holds them, and any agent its project's context. Made-up people, chats, projects and matters.

const TRUTH = join(OWNER_DATA_DIR, "truth");
const BACKUP = `${TRUTH}.packet-backup`;
const dir = mkdtempSync(join(tmpdir(), "life-packet-"));
const desk: Desk = {
  db: openDesk(join(dir, "desk.sqlite")),
  runtimes: { fake: fakeRuntime().runtime },
};

const project = (id: string, extra: string, notes = "") =>
  writeFileSync(
    join(TRUTH, "projects", `${id}.md`),
    `---\nschemaVersion: 1\nid: ${id}\nname: ${id}\narea: shop\nstatus: active\n${extra}---\n${notes}`
  );

beforeAll(() => {
  cpSync(TRUTH, BACKUP, { recursive: true });
  writeFileSync(
    join(TRUTH, "people.yaml"),
    `schemaVersion: 1
people:
  - { id: me, name: Test Owner, handles: { email: [owner@example.com] } }
  - id: test-ana
    name: Test Ana
    aliases: [Ana B]
    projects: [test-bakery]
    handles: { whatsapp: ["+10000000001"], email: [ana@example.test] }
`
  );
  writeFileSync(
    join(TRUTH, "chats.yaml"),
    `schemaVersion: 1
chats:
  - { id: "!shopgroup:example.test", name: Shop group, whatsapp: 1203630000@g.us }
  - { id: "!suppliers:example.test", name: Suppliers }
`
  );
  project(
    "test-bakery",
    "chats: ['!shopgroup:example.test', '!suppliers:example.test']\ndeadlines: [{ date: '2026-12-01', what: opening }]\n",
    `Sourdough first. ${"Flour talk. ".repeat(200)}`
  );
  project("test-empty", "");
});
afterAll(() => {
  rmSync(TRUTH, { force: true, recursive: true });
  cpSync(BACKUP, TRUTH, { recursive: true });
  rmSync(BACKUP, { force: true, recursive: true });
});

const packet = (p: string) =>
  readPacket(
    desk,
    on(
      desk,
      register(desk, { brief: "Test brief", project: p, runtime: "fake" })
    ),
    true
  );

test("a project's agent is handed its people's ids and handles and its chats' keys", async () => {
  const text = await packet("test-bakery");
  expect(text).toContain(
    "- test-ana: Test Ana (also: Ana B); email ana@example.test; whatsapp +10000000001"
  );
  expect(text).toContain("- 1203630000@g.us: Shop group\n");
  expect(text).toContain(
    "- !suppliers:example.test: Suppliers (a room id he wrote down: check it against `read_chats` before you wait on it)"
  );
});

test("the packet holds the agent's rules unless its runtime pins them", async () => {
  expect(await packet("test-empty")).toContain("Test brief\n\nYou are agt_");
  const { fake } = desk.runtimes;
  desk.runtimes.fake = {
    ...(fake as NonNullable<typeof fake>),
    pinsRules: true,
  };
  try {
    const text = await packet("test-empty");
    expect(text).not.toContain("Test brief");
    expect(text).not.toContain("a registered agent of the owner's desk");
  } finally {
    desk.runtimes.fake = fake as NonNullable<typeof fake>;
  }
});

test("a project with neither says what to do", async () => {
  const text = await packet("test-empty");
  expect(text.match(/\(none in his directory: find them/g)).toHaveLength(2);
});

test("an agent on a project's matter, and the project's agent, get the project's line, his notes clipped and where its matters are read, never a list of them; a project gone from his directory gives nothing", async () => {
  const icons = await import("../memory/matter-icons");
  // The desk's packets and matter records never pick icons (the connector's reads do).
  const iconReads = spyOn(icons, "readLifeIcons");
  const view = (id: string, projects: string[]) => ({
    ...matterView(id, [`obs_${id}`]),
    projects,
  });
  const onMatter = (step: string) =>
    readPacket(
      desk,
      on(
        desk,
        register(desk, { brief: "Test brief", runtime: "fake", steps: [step] })
      ),
      true
    );
  await withMatters(
    [
      view("mine", ["test-bakery"]),
      view("two", ["test-bakery"]),
      view("lost", ["test-gone"]),
    ],
    async () => {
      const text = await onMatter("obs_mine");
      expect(text).toContain(
        "Project test-bakery (test-bakery, active); 2026-12-01: opening\nSourdough first."
      );
      // His notes, cut at a word.
      expect(text).toContain(
        'Flour…\nIts running matters: `read_matters` with `project: "test-bakery"`.'
      );
      expect(text).not.toContain("Flour talk. ".repeat(130));
      expect(text).toContain('"id":"mine"');
      expect(text).not.toContain('"id":"two"');
      // Where the project stands (Life's reading, nightly): a line whose cited step a matter of the project holds shows; one whose step is gone does not.
      writeJson(projectSituationPath("test-bakery"), {
        built: "2026-11-10T00:00:00.000Z",
        inputs: "0123456789abcdef",
        madeBy: {
          engine: "claude",
          model: "m",
          prompt: promptNameOf("memory-project-situation.v2"),
          run: "r",
        },
        parts: [
          {
            cites: ["obs_mine"],
            markdown: "You sent the oven quote on 10 Nov.",
          },
          { cites: ["obs_gone"], markdown: "A step since re-grouped away." },
        ],
        schemaVersion: 2,
        subject: "test-bakery",
      });
      const standing = await onMatter("obs_mine");
      expect(standing).toContain(
        "You sent the oven quote on 10 Nov. [obs_mine]"
      );
      expect(standing).not.toContain("re-grouped away");
      rmSync(projectSituationPath("test-bakery"), { force: true });
      // The project's agent gets the same line.
      expect(await packet("test-bakery")).toContain(
        'Its running matters: `read_matters` with `project: "test-bakery"`.'
      );
      // A project no longer in his directory adds nothing.
      expect(await onMatter("obs_lost")).not.toContain("running matters");
    }
  );
  expect(iconReads).not.toHaveBeenCalled();
  iconReads.mockRestore();
});

test("a filter built from a printed key matches an event of that chat", async () => {
  const people = await readPeople();
  const at = "2026-01-01T00:00:00.000Z";
  const event = (source: string, chat: string) =>
    ({
      at,
      chat,
      fromMe: false,
      id: "m1",
      sender: "+10000000001",
      source,
      text: "hi",
    }) as SourceEvent;
  for (const [source, chat] of [
    ["whatsapp", "1203630000@g.us"],
    ["line", "!suppliers:example.test"],
  ] as const) {
    const match = matcherOf({ chat, from_me: false }, people);
    const e = event(source, chat);
    expect(match?.(messageMatchableOf(messagePayloadOf(e, people), e))).toBe(
      true
    );
  }
});

// Regression: a fresh session of a project's agent woken on a matter was handed its project, never its matter.
test("a fresh session of a project's agent woken on a matter starts from that matter, its project as context", async () => {
  const fake = fakeRuntime();
  const d: Desk = {
    db: openDesk(join(dir, "fresh.sqlite")),
    runtimes: { fake: fake.runtime },
  };
  const id = register(d, {
    brief: "Test brief",
    project: "test-bakery",
    runtime: "fake",
  });
  // Its own assignment waits: only the matter's first turn is due.
  writeWait(
    d.db,
    on(d, id).id,
    { events: [], reason: "r", until: iso(clock().getTime() + DAY) },
    false
  );
  openAssignment(d, id, { openedBy: "owner", steps: ["obs_mine"] });
  await withMatters([matterView("mine", ["obs_mine"])], () => wakeDue(d));
  const start = fake.said.at(-1)?.message ?? "";
  expect(agentOf(d.db, id)?.project).toBe("test-bakery");
  expect(start).toContain("Your subject, the matter as read now");
  expect(start).toContain('"id":"mine"');
  expect(start).toContain("Project test-bakery (test-bakery, active)");
});
