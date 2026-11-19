import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWNER_DATA_DIR } from "../core/paths";
import { matcherOf, messagePayloadOf } from "../host/events";
import { readPeople } from "../memory/who";
import type { SourceEvent } from "../records/source";
import { readPacket, register } from "./agent-actions";
import { type Desk, openDesk } from "./desk-store";
import { fakeRuntime } from "./runtimes/fake-runtime";

// A project's agent is handed its people and chats as the directory holds them. Made-up people, chats and projects.

const TRUTH = join(OWNER_DATA_DIR, "truth");
const BACKUP = `${TRUTH}.packet-backup`;
const dir = mkdtempSync(join(tmpdir(), "life-packet-"));
const desk: Desk = {
  db: openDesk(join(dir, "desk.sqlite")),
  runtimes: { fake: fakeRuntime().runtime },
};

const project = (id: string, extra: string) =>
  writeFileSync(
    join(TRUTH, "projects", `${id}.md`),
    `---\nschemaVersion: 1\nid: ${id}\nname: ${id}\narea: shop\nstatus: active\n${extra}---\n`
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
    "chats: ['!shopgroup:example.test', '!suppliers:example.test']\n"
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
    register(desk, { brief: "Test brief", project: p, runtime: "fake" }),
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
    expect(match?.(messagePayloadOf(e, people), e)).toBe(true);
  }
});
