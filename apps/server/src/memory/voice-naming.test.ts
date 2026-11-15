import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN } from "../core/clock";
import { apply, openStore } from "../sources/lifelog";
import {
  conversation,
  lifelogServer,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import { readConversationSummaryWork } from "./conversation-summaries";
import { readReplies } from "./read-replies";
import type { Step } from "./run";
import { unnamedTurnKey } from "./units";
import {
  checkedVoices,
  type NamingInput,
  readVoiceNamingWork,
  voiceNaming,
} from "./voice-naming";

// Made-up conversation c1: 20 turns of 1,000 characters a minute apart, him then one other voice, in job-1.
const V1_LINE = /^\[1\] \S+ V1: remark 1/;
const ME_LINE = /^\[0\] \S+ me: /;
const NOW = new Date("2026-10-20T10:00:00.000Z");
const SEEN = "2026-10-19T10:00:00.000Z";
const KNOWN: Record<string, string> = {
  Dana: "person:dana",
  p1: "person:dana",
};
const people = {
  contacts: [],
  corrections: [],
  inferred: [],
  nameOf: (s: string) => s.replace("person:", ""),
  refOf: (s: string) => s,
  resolve: (name: string) => KNOWN[name] ?? null,
  truth: { people: [] },
} as never;

let dir = "";
let n = 0;
let server: ReturnType<typeof lifelogServer> | undefined;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "voice-naming-"));
});
afterAll(async () => {
  server?.close();
  await rm(dir, { force: true, recursive: true });
});

type Scene = ReturnType<typeof sceneOf>;
type Row = Record<string, unknown>;
/** A store holding c1 (its other voice named `name` by lifelog, or nobody) and a lifelog answering `voices`, or no such route. */
const sceneOf = (o: { name?: string; voices?: Row[] }) => {
  n += 1;
  const store = join(dir, `store-${n}`);
  const where = join(dir, `trial-${n}`);
  const job = `job-${n}`;
  const turns = Array.from({ length: 20 }, (_, t) => ({
    ...turnFixture(
      t,
      new Date(Date.parse("2026-10-10T10:00:00.000Z") + t * MIN).toISOString(),
      t % 2 && o.name ? "p1" : null,
      t % 2 ? (o.name ?? null) : null,
      "c1",
      t % 2 === 0
    ),
    jobId: job,
  }));
  server?.close();
  server = lifelogServer({
    "/conversations/c1": () => ({ latestRun: null }),
    [`/transcription-jobs/${job}/transcript`]: () => ({
      turns: turns.map((_, t) => ({
        speakerId: t % 2 ? "speaker_1" : "speaker_0",
        text: `remark ${t} ${"w".repeat(1000)}`,
      })),
    }),
    ...(o.voices ? { "/speakers/voices": () => o.voices as Row[] } : {}),
  });
  const open = () => openStore(store);
  const s = open();
  apply(s, pageFixture({ conversations: [conversation("c1")], turns }), SEEN);
  s.db.close();
  return { job, open, where };
};
const row = (job: string, o: Row = {}) => ({
  basis: null,
  jobId: job,
  likeness: [],
  mixed: false,
  personId: null,
  speakerLabel: "speaker_1",
  status: null,
  ...o,
});

let asked: NamingInput[] = [];
const stepOf = (reply: (i: NamingInput) => unknown) =>
  ({
    ask: (o: { input: NamingInput }) => {
      asked.push(o.input);
      return Promise.resolve(reply(o.input));
    },
    attempt: (work: () => Promise<unknown>) => work().catch(() => undefined),
    dir: join(dir, "run"),
    end: (counts: unknown) => counts,
    llm: { engine: "codex", model: "test" },
    run: "r1",
  }) as unknown as Step;
const workOf = async (s: Scene) => {
  const found = await readConversationSummaryWork(
    NOW,
    people,
    {},
    s.where,
    s.open
  );
  return readVoiceNamingWork(found, people, s.where, s.open);
};
const run = async (s: Scene, reply: (i: NamingInput) => unknown) => {
  asked = [];
  const work = await workOf(s);
  const done = await voiceNaming(work, 40, s.where, stepOf(reply));
  return { done: done as { calls: number; stored: number }, work };
};

test("an unnamed voice is a V in the lines; its reply is kept only as far as it checks, stored under the unnamed turn's key; nothing is asked twice", async () => {
  const voices = [
    row(`job-${n + 1}`, { likeness: [{ personId: "p1", score: 0.8 }] }),
  ];
  const t = sceneOf({ voices });
  const { done, work } = await run(t, () => ({
    voices: [
      { confidence: "sure", lines: [1], person: "person:ghost", voice: "V1" },
    ],
  }));
  expect(work.counts).toEqual({ calls: 1, parts: 1 });
  expect(done).toEqual({ calls: 1, stored: 1 });
  expect(asked[0]?.lines[1]).toMatch(V1_LINE);
  expect(asked[0]?.lines[0]).toMatch(ME_LINE);
  // The one entry named someone not offered: stored as an empty answer, never as a name.
  const stored = readReplies(t.where).flat();
  expect(stored).toHaveLength(1);
  expect(JSON.stringify(stored[0])).not.toContain("person:ghost");
  expect(JSON.stringify(stored[0])).toContain("voice:speaker_1");
  expect((await workOf(t)).counts.calls).toBe(0);
});

test("a recognized voice of someone who could not be there is a V, even though lifelog named it by sound; his own answer keeps its name", async () => {
  // `job-<n+1>` is the next scene's job: build the voices for it.
  const asked1 = async (basis: string) => {
    const job = `job-${n + 1}`;
    const s = sceneOf({
      name: "Dana",
      voices: [row(job, { basis, personId: "p1", status: "person" })],
    });
    return (await run(s, () => ({ voices: [] }))).work;
  };
  const recognized = await asked1("recognized");
  expect(recognized.counts.parts).toBe(1);
  const input0 = recognized.asked[0]?.call.input as NamingInput | undefined;
  const shown = (input0?.lines ?? []).join("\n");
  expect(shown).toContain(" V1: ");
  expect(shown).not.toContain("Dana");
  // His own answer: the voice keeps its name and nothing is left to name.
  expect((await asked1("owner")).counts.parts).toBe(0);
});

test("an older Lifelog Host with no voices route stops the step with a plain message", async () => {
  const s = sceneOf({});
  await expect(workOf(s)).rejects.toThrow("needs the new Lifelog Host");
});

const input: NamingInput = {
  calls: [],
  day: "2026-10-10",
  lines: ["[0] 10:00 me: hi", "[1] 10:01 V1: hello", "[2] 10:02 V2: yes"],
  messages: [],
  people: [{ brief: "", name: "Dana", ref: "person:dana" }],
  voices: [],
};
const entry = (o: Record<string, unknown>) => ({
  confidence: "sure",
  lines: [1],
  person: "person:dana",
  voice: "V1",
  ...o,
});

test("a reply keeps an entry only when its person is offered, me or unknown, its lines are lines of that voice and its confidence is one of three", () => {
  const kept = (e: Record<string, unknown>) =>
    checkedVoices({ voices: [entry(e)] }, input).voices.length;
  expect(kept({})).toBe(1);
  expect(kept({ person: "me" })).toBe(1);
  expect(kept({ person: "unknown" })).toBe(1);
  expect(kept({ person: "person:ghost" })).toBe(0);
  expect(kept({ lines: [2] })).toBe(0);
  expect(kept({ lines: [1, 9] })).toBe(0);
  expect(kept({ confidence: "certain" })).toBe(0);
  expect(kept({ lines: [1], voice: "Dana" })).toBe(0);
  const twice = checkedVoices({ voices: [entry({}), entry({})] }, input);
  expect(twice.voices).toHaveLength(1);
  expect(() => checkedVoices({}, input)).toThrow();
  expect(unnamedTurnKey("job-1:3", "speaker_1")).toBe(
    "job-1:3 voice:speaker_1"
  );
});
