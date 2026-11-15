import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN } from "../core/clock";
import type { SourceEvent } from "../records/source";
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
  "+15550000001": "person:dana",
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
/**
 * A store holding c1 (turns of him, then `others` voices in turn; the first named `name` by lifelog, or nobody), and,
 * with `before`, c0 the day before (the first voice named Dana by lifelog), and a lifelog answering `voices` or no such route.
 */
const sceneOf = (o: {
  before?: boolean;
  name?: string;
  others?: number;
  voices?: (job: string, before: string) => Row[];
}) => {
  n += 1;
  const store = join(dir, `store-${n}`);
  const where = join(dir, `trial-${n}`);
  const [job, before] = [`job-${n}`, `job-${n}-0`];
  const every = (o.others ?? 1) + 1;
  const turnsOf = (jobId: string, from: string, count: number, c: string) =>
    Array.from({ length: count }, (_, t) => ({
      ...turnFixture(
        t,
        new Date(Date.parse(from) + t * MIN).toISOString(),
        t % every === 1 && o.name ? "p1" : null,
        t % every === 1 ? (o.name ?? null) : null,
        c,
        t % every === 0
      ),
      jobId,
    }));
  const turns = turnsOf(job, "2026-10-10T10:00:00.000Z", 20, "c1");
  const earlier = o.before
    ? turnsOf(before, "2026-10-09T10:00:00.000Z", 6, "c0")
    : [];
  const transcript = (count: number) => () => ({
    turns: Array.from({ length: count }, (_, t) => ({
      speakerId: `speaker_${t % every}`,
      text: `remark ${t} ${"w".repeat(1000)}`,
    })),
  });
  server?.close();
  server = lifelogServer({
    "/conversations/c0": () => ({ latestRun: null }),
    "/conversations/c1": () => ({ latestRun: null }),
    [`/transcription-jobs/${before}/transcript`]: transcript(6),
    [`/transcription-jobs/${job}/transcript`]: transcript(20),
    ...(o.voices ? { "/speakers/voices": () => o.voices?.(job, before) } : {}),
  });
  const open = () => openStore(store);
  const s = open();
  apply(
    s,
    pageFixture({
      conversations: [
        conversation("c1"),
        ...(o.before
          ? [
              conversation("c0", {
                endAt: "2026-10-09T10:10:00.000Z",
                startAt: "2026-10-09T10:00:00.000Z",
              }),
            ]
          : []),
      ],
      turns: [...earlier, ...turns],
    }),
    SEEN
  );
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
const workOf = async (s: Scene, chats?: SourceEvent[]) => {
  const found = await readConversationSummaryWork(
    NOW,
    people,
    {},
    s.where,
    s.open
  );
  return readVoiceNamingWork(found, people, s.where, s.open, chats);
};
const run = async (s: Scene, reply: (i: NamingInput) => unknown) => {
  asked = [];
  const work = await workOf(s);
  const done = await voiceNaming(work, 40, s.where, stepOf(reply));
  return { done: done as { calls: number; stored: number }, work };
};

test("an unnamed voice is a V in the lines; its reply is kept only as far as it checks, stored under the unnamed turn's key; nothing is asked twice", async () => {
  const t = sceneOf({
    voices: (job) => [row(job, { likeness: [{ personId: "p1", score: 0.8 }] })],
  });
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

test("a person matched by sound is not a possible speaker, and their voice is a V; the same person answered by him the day before is offered", async () => {
  const day = (answer: string | null) => {
    const s = sceneOf({
      before: true,
      name: "Dana",
      voices: (job, before) => [
        row(job, { basis: "recognized", personId: "p1", status: "person" }),
        row(before, {
          basis: answer,
          personId: "p1",
          status: "person",
        }),
      ],
    });
    return run(s, () => ({ voices: [] }));
  };
  // Matched by lifelog's sound yesterday only (never answered by him): not offered, so today's match is shown as a V.
  const bySound = (await day("recognized")).work;
  expect(bySound.counts.parts).toBe(1);
  const input0 = bySound.asked[0]?.call.input as NamingInput | undefined;
  const shown = (input0?.lines ?? []).join("\n");
  expect(shown).toContain(" V1: ");
  expect(shown).not.toContain("Dana");
  expect(input0?.people).toEqual([]);
  // Answered by him yesterday: offered, so the recognized voice keeps its name and nothing is left to name.
  expect((await day("owner")).work.counts.parts).toBe(0);
});

const CALL: SourceEvent = {
  at: "2026-10-09T09:58:00.000Z",
  chat: "+15550000001",
  fromMe: false,
  id: "call-1",
  phoneCall: { seconds: 3600, video: false },
  sender: "+15550000001",
  source: "phone",
  text: "",
};

test("a turn of someone inside a phone call with them is not heard in person, even when his answer named it", async () => {
  const scene = (chats: SourceEvent[]) => {
    const s = sceneOf({
      before: true,
      name: "Dana",
      voices: (job, before) => [
        row(job, { basis: "recognized", personId: "p1", status: "person" }),
        row(before, { basis: "owner", personId: "p1", status: "person" }),
      ],
    });
    return workOf(s, chats);
  };
  // No call: answered yesterday, so offered, and today's match keeps its name.
  expect((await scene([])).counts.parts).toBe(0);
  // The answer was given during a call with her: she is not offered, today's match is a V.
  expect((await scene([CALL])).counts.parts).toBe(1);
  // A call that ended before the turns leaves it as it was.
  const early = { ...CALL, at: "2026-10-09T08:00:00.000Z" };
  expect((await scene([early])).counts.parts).toBe(0);
});

test("a night with nothing new makes no call to lifelog's voices", async () => {
  const s = sceneOf({ voices: (job) => [row(job)] });
  await run(s, () => ({ voices: [] }));
  let calls = 0;
  server?.close();
  server = lifelogServer({
    "/conversations/c1": () => ({ latestRun: null }),
    [`/transcription-jobs/${s.job}/transcript`]: () => ({
      turns: Array.from({ length: 20 }, (_, t) => ({
        speakerId: `speaker_${t % 2}`,
        text: `remark ${t} ${"w".repeat(1000)}`,
      })),
    }),
    "/speakers/voices": () => {
      calls += 1;
      return [];
    },
  });
  expect((await workOf(s)).counts).toEqual({ calls: 0, parts: 0 });
  expect(calls).toBe(0);
});

test("a voice named later by his answer asks its part again, and the old guess no longer matches", async () => {
  const s = sceneOf({ others: 2, voices: (job) => [row(job)] });
  await run(s, () => ({ voices: [] }));
  expect((await workOf(s)).counts.calls).toBe(0);
  const store = s.open();
  store.db.run(
    "update turns set person_id = 'p1', person_name = 'Dana' where job_id = ? and turn_index % 3 = 1",
    [s.job]
  );
  store.db.close();
  const again = await workOf(s);
  expect(again.counts).toEqual({ calls: 1, parts: 1 });
  expect(readReplies(s.where).flat()).toHaveLength(1);
});

test("the hidden run shows a voice he answered as an unnamed V with no likeness, and asks only parts holding one", async () => {
  const answered = {
    basis: "owner",
    likeness: [{ personId: "p1", score: 0.9 }],
    personId: "p1",
    status: "person",
  };
  const worksOf = async (o: Row) => {
    const s = sceneOf({ name: "Dana", voices: (job) => [row(job, o)] });
    const found = await readConversationSummaryWork(
      NOW,
      people,
      {},
      s.where,
      s.open
    );
    return {
      hidden: await readVoiceNamingWork(
        found,
        people,
        s.where,
        s.open,
        undefined,
        true
      ),
      shown: await readVoiceNamingWork(found, people, s.where, s.open),
    };
  };
  const one = await worksOf(answered);
  // Not hidden, his answer names the voice and nothing is asked; hidden, it is V1 with no name.
  expect(one.shown.counts.parts).toBe(0);
  const input0 = one.hidden.asked[0]?.call.input as NamingInput;
  expect(input0.lines.join("\n")).toContain(" V1: ");
  expect(input0.lines.join("\n")).not.toContain("Dana");
  expect(input0.voices).toEqual([{ likeness: [], voice: "V1" }]);
  // His answer on the hidden voice does not make its person a possible speaker: that would hand the model the truth.
  expect(input0.people).toEqual([]);
  // A voice lifelog named by sound and a mixed one hide nothing; one he answered not relevant is hidden too.
  expect(
    (await worksOf({ ...answered, basis: "recognized" })).hidden.counts.parts
  ).toBe(0);
  expect(
    (await worksOf({ ...answered, mixed: true })).hidden.counts.parts
  ).toBe(0);
  expect(
    (await worksOf({ ...answered, personId: null, status: "not_relevant" }))
      .hidden.counts.parts
  ).toBe(1);
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
