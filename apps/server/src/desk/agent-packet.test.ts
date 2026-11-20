import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import {
  matcherOf,
  messageMatchableOf,
  messagePayloadOf,
} from "../host/events";
import { readPeople } from "../memory/who";
import type { SourceEvent } from "../records/source";
import { readPacket, register } from "./agent-actions";
import { type Desk, openDesk } from "./desk-store";
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
