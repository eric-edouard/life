import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock } from "../core/clock";
import { logFileOf } from "../core/log";
import { dayStart } from "../memory/zones";
import { Correction } from "../records/observation";
import { migrateSettings, migrateVoiceSource, settingsOf } from "./migrate";

test("the settings step drops `agents` and keeps the rest; a file without it is left as it is", () => {
  const without = { sources: ["git"] };
  expect(settingsOf(without)).toBe(without);
  const state = mkdtempSync(join(tmpdir(), "life-migrate-"));
  const path = join(state, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({ agents: { Comet: { wake: ["comet"] } }, ...without })
  );
  migrateSettings(state);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(without);
});

test("a helper starting after the step leaves a later change of the settings as it is", () => {
  const state = mkdtempSync(join(tmpdir(), "life-migrate-"));
  const path = join(state, "settings.json");
  writeFileSync(
    path,
    JSON.stringify({ agents: {}, memoryLanguage: "English" })
  );
  migrateSettings(state);
  writeFileSync(path, JSON.stringify({ memoryLanguage: "French" }));
  migrateSettings(state);
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
    memoryLanguage: "French",
  });
  expect(existsSync(`${path}.migrate.lock`)).toBe(false);
});

test("the settings step drops `notifications` too", () => {
  expect(settingsOf({ notifications: {}, sources: ["git"] })).toEqual({
    sources: ["git"],
  });
});

test("the corrections step: a Not now becomes Later on its card's ref, line for line; every other line stays byte for byte", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-migrate-data-"));
  mkdirSync(join(dir, "memory"));
  const path = join(dir, "memory", "corrections.jsonl");
  const other =
    '{"at":"2026-11-15T09:00:00.000Z","kind":"wrong","observations":["obs_000000000001"],"schemaVersion":1}';
  const notNow = JSON.stringify({
    at: "2026-11-15T09:00:00.000Z",
    kind: "your-move-not-now",
    matter: "matter_000000000007",
    schemaVersion: 1,
    steps: ["obs_000000000002", "obs_000000000003"],
    until: "2026-11-18",
  });
  writeFileSync(path, `${other}\n${notNow}\n${other}\n`);
  migrateSettings(mkdtempSync(join(tmpdir(), "life-migrate-")), dir);
  const lines = readFileSync(path, "utf8").split("\n");
  expect(lines).toHaveLength(4);
  expect(lines[0]).toBe(other);
  expect(lines[2]).toBe(other);
  const moved = Correction.parse(JSON.parse(lines[1] ?? ""));
  expect(moved).toMatchObject({
    kind: "deferred",
    ref: "move:matter_000000000007",
  });
  expect(Date.parse((moved as { until: string }).until)).toBe(
    dayStart("2026-11-18").getTime()
  );
  // Run again, nothing changes.
  const before = readFileSync(path, "utf8");
  migrateSettings(mkdtempSync(join(tmpdir(), "life-migrate-")), dir);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("the settings step names the voice source `voice` in `sources`, its `lifelog` key left for its own step", () => {
  expect(
    settingsOf({
      lifelog: { url: "https://voice.example.test" },
      sources: ["lifelog", "git"],
    })
  ).toEqual({
    lifelog: { url: "https://voice.example.test" },
    sources: ["voice", "git"],
  });
  const done = { sources: ["voice", "git"] };
  expect(settingsOf(done)).toBe(done);
});

const VOICE_FILES = {
  "appointment-events.jsonl": [
    '{"at":"2026-11-01T09:00:00.000Z","kind":"added","messages":["lifelog|job1:2@2026-11-01T08:00:00.000Z","whatsapp|m1"],"title":"lifelog demo"}',
  ],
  "corrections.jsonl": [
    '{"inConversation":"lifelog|call-bloom","kind":"this-is","nameOrHandle":"David","note":"lifelog said so"}',
    '{"inConversation":"whatsapp|chat-1","kind":"this-is","nameOrHandle":"Ana"}',
    '{"inConversation":"lifelog|torn',
  ],
  "fact-checks.jsonl": [
    '{"source":"lifelog","text":"Ana said lifelog works"}',
    '{"source":null,"text":"lifelog"}',
  ],
  "observations/2026-10.jsonl": [
    '{"about":"project:lifelog","quote":"the lifelog app","source":{"channel":"lifelog","ref":"job1:2@2026-11-01T08:00:00.000Z"},"subjects":["project:lifelog"]}',
    '{"source":{"channel":"whatsapp","ref":"whatsapp:c/m"},"text":"lifelog"}',
    "",
  ],
  "publications.jsonl": ['{"sources":["lifelog","git"]}'],
  "read-replies/2026-11.jsonl": [
    '{"messages":["lifelog|job1:1@x","lifelog|job1:2@x"],"reply":{"projects":[{"project":"lifelog"}],"text":"lifelog|not a key"}}',
    '{"messages":["voice|job2:1@x"]}',
  ],
  "units/2026-10-09.jsonl": [
    '{"id":"unit_000000000001","key":"conv-1","source":"lifelog","title":"lifelog: a talk"}',
    '{"id":"unit_000000000002","key":"lifelog","refs":["git:lifelog/abc"],"source":"git","title":"lifelog: 16 commits"}',
    '{"id":"unit_000000000003","key":"conv-2","source":"voice"}',
  ],
} satisfies Record<string, string[]>;

test("the voice source step renames typed fields only, line for line: text, projects and new lines byte for byte; a second run changes nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-migrate-voice-"));
  const state = mkdtempSync(join(tmpdir(), "life-migrate-voice-state-"));
  for (const [file, lines] of Object.entries(VOICE_FILES)) {
    mkdirSync(join(dir, "memory", file, ".."), { recursive: true });
    writeFileSync(join(dir, "memory", file), `${lines.join("\n")}\n`);
  }
  mkdirSync(join(state, "log"));
  const reads =
    '{"kind":"model.run","reads":{"lifelog":12,"mail":3},"title":"lifelog"}';
  const today = logFileOf(clock().toISOString());
  writeFileSync(
    join(state, "log", "2026-11-01.jsonl"),
    `${reads}\nnot json "lifelog":\n`
  );
  writeFileSync(join(state, "log", today), `${reads}\n`);

  expect(migrateVoiceSource(dir, state)).toEqual({
    "appointment-events.jsonl": 1,
    "corrections.jsonl": 1,
    "fact-checks.jsonl": 1,
    log: 1,
    observations: 1,
    "publications.jsonl": 1,
    "read-replies": 1,
    units: 1,
  });
  const read = (file: string) =>
    readFileSync(join(dir, "memory", file), "utf8").split("\n");
  for (const [file, lines] of Object.entries(VOICE_FILES)) {
    expect(read(file).length).toBe(lines.length + 1);
  }
  const rows = (file: string) =>
    read(file)
      .filter((l) => l.endsWith("}"))
      .map((l) => JSON.parse(l));
  expect(
    rows("units/2026-10-09.jsonl").map((u) => [u.source, u.key, u.title])
  ).toEqual([
    ["voice", "conv-1", "lifelog: a talk"],
    ["git", "lifelog", "lifelog: 16 commits"],
    ["voice", "conv-2", undefined],
  ]);
  // A line already new, and one with no source of the voice, stay byte for byte.
  expect(read("units/2026-10-09.jsonl").slice(1, 3)).toEqual(
    VOICE_FILES["units/2026-10-09.jsonl"].slice(1, 3)
  );
  expect(rows("observations/2026-10.jsonl")[0]).toEqual({
    about: "project:lifelog",
    quote: "the lifelog app",
    source: { channel: "voice", ref: "job1:2@2026-11-01T08:00:00.000Z" },
    subjects: ["project:lifelog"],
  });
  expect(rows("fact-checks.jsonl").map((c) => [c.source, c.text])).toEqual([
    ["voice", "Ana said lifelog works"],
    [null, "lifelog"],
  ]);
  expect(rows("publications.jsonl")[0].sources).toEqual(["voice", "git"]);
  expect(rows("read-replies/2026-11.jsonl")[0]).toEqual({
    messages: ["voice|job1:1@x", "voice|job1:2@x"],
    reply: { projects: [{ project: "lifelog" }], text: "lifelog|not a key" },
  });
  expect(rows("appointment-events.jsonl")[0].messages).toEqual([
    "voice|job1:2@2026-11-01T08:00:00.000Z",
    "whatsapp|m1",
  ]);
  // A torn last line stays as it is.
  expect(read("corrections.jsonl").at(-2)).toBe(
    '{"inConversation":"lifelog|torn'
  );
  expect(rows("corrections.jsonl").map((c) => c.inConversation)).toEqual([
    "voice|call-bloom",
    "whatsapp|chat-1",
  ]);
  // The past days' logs only: today's is still being appended to.
  expect(readFileSync(join(state, "log", "2026-11-01.jsonl"), "utf8")).toBe(
    '{"kind":"model.run","reads":{"mail":3,"voice":12},"title":"lifelog"}\nnot json "lifelog":\n'
  );
  expect(readFileSync(join(state, "log", today), "utf8")).toBe(`${reads}\n`);

  const after = Object.keys(VOICE_FILES).map(read);
  expect(migrateVoiceSource(dir, state)).toBeNull();
  expect(Object.keys(VOICE_FILES).map(read)).toEqual(after);
  // Without its mark, a run again finds nothing to rename.
  rmSync(join(dir, "memory", "migrations.jsonl"));
  expect(
    Object.values(migrateVoiceSource(dir, state) ?? { none: 1 }).every(
      (n) => n === 0
    )
  ).toBe(true);
  expect(Object.keys(VOICE_FILES).map(read)).toEqual(after);
});
