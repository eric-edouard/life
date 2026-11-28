import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIN } from "../core/clock";
import { stamp } from "../models/llm";
import { apply, openStore } from "../sources/voice-server";
import {
  conversation,
  lifelogServer,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import {
  conversationSummaries,
  conversationSummaryPart,
  currentSummaries,
  maxWordsOf,
  readConversationSummaryWork,
  summaryLine,
} from "./conversation-summaries";
import { readReplies } from "./read-replies";
import type { Step } from "./run";
import { time } from "./zones";

// Made-up conversations: turns of 1,000 characters, him then another voice, a minute apart. A conversation is `job-<n>`.
const NOW = new Date("2026-10-20T10:00:00.000Z");
const SEEN = "2026-10-19T10:00:00.000Z";
const people = {
  nameOf: (s: string) => s.replace("person:", ""),
  resolve: (name: string) => `person:${name}`,
  truth: { people: [] },
} as never;

let dir = "";
let n = 0;
let server: ReturnType<typeof lifelogServer> | undefined;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "summaries-"));
});
afterAll(async () => {
  server?.close();
  await rm(dir, { force: true, recursive: true });
});

const voiceOf = (t: number, screen?: number) => {
  if (t === screen) {
    return "speaker_9";
  }
  return t % 2 ? "speaker_1" : "speaker_0";
};

interface Scene {
  open: () => ReturnType<typeof openStore>;
  where: string;
}
/** A fresh store and trial folder holding `talks`: for each conversation, how many turns, on which day, and who the other voice is. */
const sceneOf = (
  talks: {
    day: number;
    name?: string;
    /** A screen voice's turn, with a long silence after it. */
    screen?: number;
    turns: number;
  }[],
  texts: (job: string, turn: number) => string = (job, t) =>
    `${job} remark number ${t} here`
): Scene => {
  n += 1;
  const store = join(dir, `store-${n}`);
  const where = join(dir, `trial-${n}`);
  const jobs = new Map<string, string[]>();
  const withScreen = talks.findIndex((t) => t.screen !== undefined);
  const screen = talks[withScreen]?.screen;
  const screenJob = `job-${n}-${withScreen}`;
  const turns = talks.flatMap((talk, c) =>
    Array.from({ length: talk.turns }, (_, t) => {
      const job = `job-${n}-${c}`;
      const list = jobs.get(job) ?? [];
      list.push(`${texts(job, t)} ${"w".repeat(1000)}`);
      jobs.set(job, list);
      const at = new Date(
        Date.parse("2026-10-10T10:00:00.000Z") +
          talk.day * 86_400_000 +
          (t + (talk.screen !== undefined && t > talk.screen ? 3 : 0)) * MIN
      ).toISOString();
      return {
        ...turnFixture(
          t,
          at,
          t % 2 && talk.name ? "p1" : null,
          t % 2 ? (talk.name ?? null) : null,
          "c1",
          t % 2 === 0
        ),
        jobId: job,
      };
    })
  );
  server?.close();
  server = lifelogServer({
    "/conversations/c1": () => ({
      latestRun: {
        result: {
          speakerIdentities: [
            {
              jobId: screenJob,
              kind: "media",
              speakerLabel: "speaker_9",
              withOwner: false,
            },
          ],
        },
      },
    }),
    ...Object.fromEntries(
      [...jobs].map(([job, list]) => [
        `/transcription-jobs/${job}/transcript`,
        () => ({
          turns: list.map((text, t) => ({
            speakerId: voiceOf(t, screen),
            text,
          })),
        }),
      ])
    ),
  });
  const open = () => openStore(store);
  const s = open();
  apply(s, pageFixture({ conversations: [conversation("c1")], turns }), SEEN);
  s.db.close();
  return { open, where };
};

let asked: Record<string, unknown>[] = [];
const stepOf = (reply: (input: Record<string, unknown>) => unknown) => ({
  ask: (o: { input: Record<string, unknown> }) => {
    asked.push(o.input);
    return Promise.resolve(reply(o.input));
  },
  attempt: (work: () => Promise<unknown>) => work().catch(() => undefined),
  dir: join(dir, "run"),
  end: (counts: unknown) => counts,
  keeps: () => false,
  llm: { engine: "codex", model: "test" },
  madeBy: (prompt: string) =>
    stamp({ engine: "codex", model: "test" }, prompt, "r1"),
  run: "r1",
});
const SAID = {
  doubts: ["V1 may be the plumber"],
  quotes: [{ line: 3, quote: "remark number 3 here" }],
  subjects: [{ label: "The quote", line: 1 }],
  summary: "They agreed the quote.",
};
const run = async (
  s: Scene,
  reply: (i: Record<string, unknown>) => unknown,
  cap?: number
) => {
  asked = [];
  const found = await readConversationSummaryWork(
    NOW,
    people,
    {},
    s.where,
    s.open
  );
  const done = await conversationSummaries(
    found,
    cap,
    s.where,
    stepOf(reply) as unknown as Step,
    s.open
  );
  return { done: done as { calls: number; stored: number }, found };
};

test("the size asked for grows with the part: 300, 400 and 2000 words at 15k, 30k and 150k characters", () => {
  expect([15_000, 30_000, 150_000].map(maxWordsOf)).toEqual([300, 400, 2000]);
});

test("a long conversation is asked once, stored as given and shown; asking again asks nothing", async () => {
  const s = sceneOf([{ day: 0, name: "Dana", turns: 20 }]);
  const first = await run(s, () => SAID);
  expect(first.found.counts).toEqual({ conversations: 1, parts: 1 });
  expect(asked).toHaveLength(1);
  expect(asked[0]?.words).toBe(300);
  expect(asked[0]?.people).toEqual(["Dana"]);
  expect(readReplies(s.where).flat()).toHaveLength(1);
  const [held] = await currentSummaries(s.open, s.where);
  expect(held?.speakers.map((v) => v.name)).toEqual(["Dana"]);
  expect(summaryLine(held as never)).toBe(
    `- 2026-10-10 ${time(held?.at ?? "")} The quote: They agreed the quote. (\`fetch person:me/conversation/${held?.ref}\`)`
  );
  const again = await run(s, () => SAID);
  expect(again.found.counts.parts).toBe(0);
  expect(asked).toHaveLength(0);
});

test("a short conversation is found (the voice naming reads it) but never summarised or counted", async () => {
  const s = sceneOf([{ day: 0, name: "Dana", turns: 10 }]);
  const { done, found } = await run(s, () => SAID);
  expect(found.parts).toHaveLength(1);
  expect(found.counts).toEqual({ conversations: 0, parts: 0 });
  expect(done.calls).toBe(0);
});

test("a part waits for the one before it and is given its summary; a failed call stores nothing and is not asked again that night", async () => {
  const s = sceneOf([{ day: 0, turns: 160 }]);
  const found = await readConversationSummaryWork(
    NOW,
    people,
    {},
    s.where,
    s.open
  );
  expect(found.parts[0]).toHaveLength(2);
  const { done } = await run(s, (i) => ({
    ...SAID,
    summary: i.previous ? "Second." : "First.",
  }));
  expect(done).toEqual({ calls: 2, stored: 2 });
  expect(asked.map((a) => a.previous)).toEqual([undefined, "First."]);
  const failing = sceneOf([{ day: 0, turns: 20 }]);
  const lost = await run(failing, () => {
    throw new Error("no answer");
  });
  expect(lost.done).toEqual({ calls: 1, stored: 0 });
  expect(asked).toHaveLength(1);
  expect(readReplies(failing.where).flat()).toHaveLength(0);
});

test("a voice given another name makes the part pending again and hides the old summary", async () => {
  const s = sceneOf([{ day: 0, name: "Dana", turns: 20 }]);
  await run(s, () => SAID);
  expect(await currentSummaries(s.open, s.where)).toHaveLength(1);
  const store = s.open();
  const [first] = store.db
    .query<{ job_id: string }, []>("select job_id from turns limit 1")
    .all();
  store.db.run(
    "update turns set person_id = 'p2' where job_id = ? and turn_index = 1",
    [first?.job_id ?? ""]
  );
  store.db.close();
  expect(await currentSummaries(s.open, s.where)).toEqual([]);
  const found = await readConversationSummaryWork(
    NOW,
    people,
    {},
    s.where,
    s.open
  );
  expect(found.counts.parts).toBe(1);
  await Bun.sleep(5);
  await run(s, () => ({ ...SAID, summary: "Redone." }));
  expect(
    (await currentSummaries(s.open, s.where)).map((h) => h.summary)
  ).toEqual(["Redone."]);
});

/** Gives the voice of turn 1 to `person` (p1 is Dana). */
const giveVoiceTo = (s: Scene, person: string) => {
  const store = s.open();
  store.db.run("update turns set person_id = ? where turn_index = 1", [person]);
  store.db.close();
};
const shown = async (s: Scene) =>
  (await currentSummaries(s.open, s.where)).map((h) => h.summary);
const pending = async (s: Scene) =>
  (await readConversationSummaryWork(NOW, people, {}, s.where, s.open)).counts
    .parts;

test("a voice renamed and renamed back shows its first summary again with no new call", async () => {
  const s = sceneOf([{ day: 0, name: "Dana", turns: 20 }]);
  await run(s, () => ({ ...SAID, summary: "First." }));
  giveVoiceTo(s, "p2");
  expect([await shown(s), await pending(s)]).toEqual([[], 1]);
  giveVoiceTo(s, "p1");
  expect([await shown(s), await pending(s)]).toEqual([["First."], 0]);
  await run(s, () => SAID);
  expect(asked).toHaveLength(0);
});

test("renamed, summarised again, then renamed back: the first line shows and the second is ignored", async () => {
  const s = sceneOf([{ day: 0, name: "Dana", turns: 20 }]);
  await run(s, () => ({ ...SAID, summary: "First." }));
  giveVoiceTo(s, "p2");
  await Bun.sleep(5);
  await run(s, () => ({ ...SAID, summary: "Second." }));
  expect(await shown(s)).toEqual(["Second."]);
  giveVoiceTo(s, "p1");
  expect([await shown(s), await pending(s)]).toEqual([["First."], 0]);
});

test("a part's next is the following part of the same conversation, never another conversation", async () => {
  const two = sceneOf([
    { day: 0, turns: 20 },
    { day: 1, turns: 20 },
  ]);
  await run(two, () => SAID);
  const held = await currentSummaries(two.open, two.where);
  expect(held).toHaveLength(2);
  expect(held.map((h) => h.next)).toEqual([undefined, undefined]);
  const long = sceneOf([{ day: 0, turns: 160 }]);
  await run(long, () => SAID);
  const [first, second] = await currentSummaries(long.open, long.where);
  expect(first?.next).toBe(second?.ref);
  expect(second?.next).toBeUndefined();
  // A turn left out of the lines (a screen voice) at the cut hides nothing.
  const cut = sceneOf([{ day: 0, screen: 81, turns: 160 }]);
  await run(cut, () => SAID);
  const [one, other] = await currentSummaries(cut.open, cut.where);
  expect(other).toBeDefined();
  expect(one?.keys).toHaveLength(81);
  expect(one?.next).toBe(other?.ref);
});

test("the cap bounds a night's calls, newest conversation first", async () => {
  const s = sceneOf([
    { day: 0, turns: 20 },
    { day: 1, turns: 20 },
    { day: 2, turns: 20 },
  ]);
  const { done } = await run(s, () => SAID, 2);
  expect(done).toEqual({ calls: 2, stored: 2 });
  const days = (await currentSummaries(s.open, s.where)).map((h) =>
    h.at.slice(0, 10)
  );
  expect(days).toEqual(["2026-10-11", "2026-10-12"]);
});

test("a conversation lifelog brought in over a week ago is not examined, unless `from` goes back to it", async () => {
  const s = sceneOf([{ day: 0, turns: 20 }]);
  const late = new Date("2026-11-30T10:00:00.000Z");
  const quiet = await readConversationSummaryWork(
    late,
    people,
    {},
    s.where,
    s.open
  );
  expect(quiet.parts).toEqual([]);
  const from = await readConversationSummaryWork(
    late,
    people,
    { from: "2026-10-01" },
    s.where,
    s.open
  );
  expect(from.parts).toHaveLength(1);
});

test("the read part shows the subjects whose line exists and the quotes found on their line, and drops the others", async () => {
  const s = sceneOf([{ day: 0, name: "Dana", turns: 20 }]);
  await run(s, () => ({
    ...SAID,
    quotes: [
      { line: 3, quote: "remark number 3 here" },
      { line: 4, quote: "remark number 3 here" },
      { line: 3, quote: "never said" },
    ],
    subjects: [
      { label: "The quote", line: 1 },
      { label: "Past the end", line: 99 },
    ],
  }));
  const [held] = await currentSummaries(s.open, s.where);
  const lines = await conversationSummaryPart(held?.ref ?? "", s.open, s.where);
  const text = (lines ?? []).join("\n");
  expect(text).toContain("written from its 20 lines (recorded in person)");
  expect(text).toContain("- The quote (`fetch ");
  expect(text).not.toContain("Past the end");
  expect(text).toContain('- "remark number 3 here');
  expect(text).not.toContain("never said");
  expect(text.match(/- "remark number 3 here/g)).toHaveLength(1);
  expect(text).toContain("- V1 may be the plumber");
  expect(
    await conversationSummaryPart(
      "job-x:0@2026-10-10T10:00:00.000Z",
      s.open,
      s.where
    )
  ).toBeNull();
});
