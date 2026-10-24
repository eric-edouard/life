import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import {
  chapters,
  conversations,
  intelligenceRuns,
  ownerEdits,
  sources,
  timelineSpans,
  transcriptionJobs,
  transcripts,
} from "@lifelog/db/schema";
import { asc, eq } from "drizzle-orm";
import { PARSER_VERSION } from "./elevenlabs";
import { feed } from "./feed";
import { anchorId, groupSource, markDirty, saveEdit } from "./grouping";
import { chapterLatency } from "./latency";
import { MacGone, type ModelCall } from "./providers";
import { rollingChapters } from "./rolling";
import { dueConversations, fingerprint } from "./summaries";
import { PROMPT_VERSION } from "./summary-calls";
import { setSwitches } from "./switches";
import { fakeAnswer, fakeModel, stageOf, testDb } from "./testing";
import { rebuildTurns } from "./turns";

let env: Awaited<ReturnType<typeof testDb>>;

beforeAll(() => {
  env = testDb();
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
  // Summaries on (off by default), as these tests roll them.
  setSwitches(env.db, { ai: true });
});

const SOURCE = "pendant-1";
const T0 = Date.parse("2026-10-14T10:00:00Z");
const at = (s: number) => T0 + s * 1000;
const iso = (s: number) => new Date(at(s)).toISOString();

// A block of `n` turns of 10 s from `start` (seconds): its job, transcript and turns, the span the
// phone sends for it (speech throughout), then grouping with heard-through at `heard`.
function block(start: number, n: number, heard: number) {
  const end = start + n * 10;
  const [job] = env.db
    .insert(transcriptionJobs)
    .values({
      audioSha256: randomUUID(),
      billableSeconds: n * 10,
      captureEnd: new Date(at(end)),
      captureStart: new Date(at(start)),
      map: { segments: [[at(start), at(end)]], separatorMs: 0 },
      preparedDurationSeconds: n * 10,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      sourceId: SOURCE,
      state: "completed",
    })
    .returning()
    .all();
  if (!job) {
    throw new Error("no job");
  }
  const turns = Array.from({ length: n }, (_, i) => ({
    end: i * 10 + 8,
    speakerId: `speaker_${i % 2}`,
    start: i * 10,
    text: `Turn ${start / 10 + i}.`,
  }));
  env.db
    .insert(transcripts)
    .values({
      createdAt: new Date(Date.now() - 3_600_000),
      jobId: job.id,
      languageCode: "eng",
      parsed: { languageCode: "eng", languageProbability: 1, turns, words: [] },
      parserVersion: PARSER_VERSION,
      raw: {},
    })
    .run();
  rebuildTurns(env.db, job.id);
  env.db
    .insert(sources)
    .values({ heardThrough: new Date(at(heard)), id: SOURCE })
    .onConflictDoUpdate({
      set: { heardThrough: new Date(at(heard)) },
      target: sources.id,
    })
    .run();
  env.db
    .insert(timelineSpans)
    .values({
      endAt: new Date(at(end)),
      facts: {
        audible: [[iso(start), iso(end)]],
        breaks: [],
        pauses: [],
        speech: [[iso(start), iso(end)]],
        unanalyzed: [],
      },
      firstPage: start,
      sourceId: SOURCE,
      startAt: new Date(at(start)),
    })
    .run();
  markDirty(env.db, [SOURCE], [at(start), at(end)]);
  groupSource(env.db, SOURCE);
}

// Heard-through moves on: conversations it passed by 5 minutes close.
function hear(heard: number) {
  env.db
    .update(sources)
    .set({ heardThrough: new Date(at(heard)) })
    .where(eq(sources.id, SOURCE))
    .run();
  groupSource(env.db, SOURCE);
}

test("the fingerprint is the one Postgres made: 'open:' while open, md5 of the turn refs in order", () => {
  block(0, 3, 0);
  const [c] = env.db.select().from(conversations).all();
  const job = env.db.query.transcriptionJobs.findFirst().sync();
  if (!(c && job)) {
    throw new Error("no conversation");
  }
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const refs = [0, 1, 2].map((i) => `${job.id}:${i}`).join(",");
  expect(fingerprint(env.db, c.id)).toBe(`open:${md5(refs)}`);
  hear(1000);
  expect(fingerprint(env.db, c.id)).toBe(md5(refs));
});

const RANGE = /must cover turns (\d+) to (\d+)/;
// Chapters of five turns over the range asked; `boundary` adds a confident new conversation
// there when it starts a chapter of the range.
function answer(boundary?: number, confidence: "high" | "medium" = "high") {
  let summaries = 0;
  return (call: ModelCall) => {
    if (stageOf(call) === "chapters") {
      const [, a = "0", b = "0"] = RANGE.exec(call.user) ?? [];
      const [first, last] = [Number(a), Number(b)];
      const parts: { endTurnId: number; startTurnId: number; title: string }[] =
        [];
      for (let s = first; s <= last; s += 5) {
        parts.push({
          endTurnId: Math.min(s + 4, last),
          startTurnId: s,
          title: `From ${s}`,
        });
      }
      return {
        boundaries:
          boundary !== undefined && boundary > first && boundary <= last
            ? [
                {
                  cause: "people",
                  confidence,
                  evidenceTurnIds: [boundary],
                  reason: "goodbyes, then other people",
                  turnId: boundary,
                },
              ]
            : [],
        chapters: parts,
        languages: ["en"],
        speakers: [],
      };
    }
    if (stageOf(call) === "chapter") {
      summaries += 1;
      return {
        evidenceTurnIds: [],
        summary: `Summary ${summaries}.`,
      };
    }
    return fakeAnswer(call);
  };
}

const conversation = () =>
  env.db
    .select()
    .from(conversations)
    .orderBy(asc(conversations.captureStartedAt))
    .all()
    .filter((c) => c.retiredAt === null);
const rows = () =>
  env.db.select().from(chapters).orderBy(asc(chapters.startAt)).all();
const plans = (calls: ModelCall[]) =>
  calls
    .filter((c) => stageOf(c) === "chapters")
    .map((c) => RANGE.exec(c.user)?.slice(1).map(Number));

test("chapters are summarized while the conversation goes on, the last when it closes", async () => {
  const model = fakeModel(answer());
  const rolling = rollingChapters(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 100);
  await rolling.drain();
  const [open] = conversation();
  expect(open?.closedAt).toBeNull();
  // Turns 0-4 closed (5-9 may go on): summarized, titled, in the feed's table.
  const first = rows();
  expect(
    first.map((r) => [
      r.title,
      r.summary,
      r.startAt.getTime(),
      r.endAt.getTime(),
    ])
  ).toEqual([["From 0", "Summary 1.", at(0), at(50)]]);
  expect(first[0]?.summarizedAt).not.toBeNull();
  expect(first[0]?.id).toBeString();

  // The next block: the tail from turn 5 is read, nothing before it.
  block(100, 10, 200);
  await rolling.drain();
  expect(rows().map((r) => r.title)).toEqual(["From 0", "From 5", "From 10"]);
  expect(rows()[0]?.id).toBe(first[0]?.id as string);

  // Nothing new: no call.
  const calls = model.calls.length;
  await rolling.drain();
  expect(model.calls.length).toBe(calls);

  // Closed: the last chapter closes at the conversation's end and the title settles.
  hear(600);
  await rolling.drain();
  const all = rows();
  expect(all.map((r) => r.title)).toEqual([
    "From 0",
    "From 5",
    "From 10",
    "From 15",
  ]);
  expect(all.at(-1)?.endAt.getTime()).toBe(at(200));
  expect(plans(model.calls)).toEqual([
    [0, 9],
    [5, 19],
    [15, 19],
  ]);
  const runs = env.db.select().from(intelligenceRuns).all();
  // Every roll that closed something is a run of the Mac's, at no cost.
  expect(runs.map((r) => [r.state, r.provider, r.costUsd])).toEqual([
    ["valid", "claude-code", 0],
    ["valid", "claude-code", 0],
    ["valid", "claude-code", 0],
  ]);
  expect(chapterLatency(env.db, new Date(0)).chapters).toBe(4);
});

test("summaries off: a due conversation makes no run and nothing is due; turned on, it rolls", async () => {
  setSwitches(env.db, { ai: false });
  const model = fakeModel(answer());
  const rolling = rollingChapters(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 1000);
  await rolling.drain();
  expect(env.db.select().from(intelligenceRuns).all()).toEqual([]);
  expect(rolling.due()).toEqual([]);
  setSwitches(env.db, { ai: true });
  await rolling.drain();
  const runs = env.db.select().from(intelligenceRuns).all();
  expect(runs.map((r) => r.state)).toEqual(["valid"]);
});

test("a confident new conversation becomes an AI split, grouped at once, once", async () => {
  const model = fakeModel(answer(5));
  const rolling = rollingChapters(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 100);
  await rolling.drain();
  const edits = env.db.select().from(ownerEdits).all();
  expect(edits.map((e) => [e.source, e.kind, e.at?.getTime()])).toEqual([
    ["ai", "split", at(50)],
  ]);
  expect(conversation().map((c) => c.id)).toEqual([
    anchorId(at(0)),
    anchorId(at(50)),
  ]);
  // Turns 0-4 closed before the new conversation.
  expect(rows().map((r) => [r.conversationId, r.title])).toEqual([
    [anchorId(at(0)), "From 0"],
  ]);
  await rolling.idle();
  await rolling.drain();
  expect(env.db.select().from(ownerEdits).all().length).toBe(1);
});

// The owner's Generate of the conversation at `id`, and every roll it leads to.
async function generate(model: ReturnType<typeof fakeModel>, id: string) {
  const rolling = rollingChapters(env.db, { mac: model, windowChars: 100_000 });
  rolling.generate(id);
  await rolling.idle();
  // The pieces a split made are due: they roll now (in the app, with the split, in the background).
  await rolling.drain();
  await rolling.idle();
}

test("Generate stores a confident new conversation as an AI split, once; each piece keeps its own chapters", async () => {
  const model = fakeModel(answer(5));
  block(0, 10, 1000);
  await generate(model, anchorId(at(0)));
  const edits = env.db.select().from(ownerEdits).all();
  expect(edits.map((e) => [e.source, e.kind, e.at?.getTime()])).toEqual([
    ["ai", "split", at(50)],
  ]);
  expect(conversation().map((c) => c.id)).toEqual([
    anchorId(at(0)),
    anchorId(at(50)),
  ]);
  // Only the chapters before the cut stay the original's; the piece after it rolled on its own.
  expect(rows().map((r) => [r.conversationId, r.startAt.getTime()])).toEqual([
    [anchorId(at(0)), at(0)],
    [anchorId(at(50)), at(50)],
  ]);
  // The owner puts it back together; Generate again finds the same boundary and leaves it.
  saveEdit(env.db, {
    edit: edits[0]?.id as string,
    editedAt: new Date().toISOString(),
    id: randomUUID(),
    kind: "undo",
  });
  groupSource(env.db, SOURCE);
  expect(conversation().length).toBe(1);
  await generate(model, anchorId(at(0)));
  expect(conversation().length).toBe(1);
  expect(
    env.db
      .select()
      .from(ownerEdits)
      .all()
      .filter((e) => e.kind === "split").length
  ).toBe(1);
});

test.each([
  ["a roll", false],
  ["Generate", true],
])("a medium boundary from %s is only offered", async (_name, whole) => {
  const model = fakeModel(answer(5, "medium"));
  block(0, 10, 100);
  if (whole) {
    await generate(model, anchorId(at(0)));
  } else {
    // A roll closes chapters before the boundary only once the conversation goes on.
    const rolling = rollingChapters(env.db, {
      mac: model,
      windowChars: 100_000,
    });
    await rolling.drain();
  }
  expect(env.db.select().from(ownerEdits).all()).toEqual([]);
  expect(conversation().length).toBe(1);
  const { conversations: listed } = feed(env.db, 0);
  expect(listed.map((c) => c.splitSuggestions)).toEqual([
    [{ at: iso(50), confidence: "medium" }],
  ]);
});

test("a chapter summarized again keeps its id", async () => {
  const model = fakeModel(answer());
  const rolling = rollingChapters(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 600);
  await rolling.drain();
  const before = rows();
  expect(before.map((r) => r.summary)).toEqual(["Summary 1.", "Summary 2."]);
  // The owner's Generate: from the first turn again, its chapters starting at the same turns.
  await generate(model, anchorId(at(0)));
  const after = rows();
  expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
  expect(after.map((r) => r.summary)).toEqual(["Summary 3.", "Summary 4."]);
  expect(after[0]?.summarizedAt).toEqual(before[0]?.summarizedAt as Date);
});

test("with the Mac away nothing is called; a roll it dropped resumes where it stopped", async () => {
  let ready = false;
  let dropped = false;
  const respond = answer();
  const model = Object.assign(
    fakeModel((call) => {
      if (stageOf(call) === "chapter" && !dropped) {
        dropped = true;
        throw new MacGone("the Mac is away");
      }
      return respond(call);
    }),
    { ready: () => ready }
  );
  const rolling = rollingChapters(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 100);
  await rolling.drain();
  await rolling.drain();
  expect(model.calls.length).toBe(0);
  expect(env.db.select().from(intelligenceRuns).all()).toEqual([]);

  ready = true;
  await rolling.drain();
  const [waiting] = env.db.select().from(intelligenceRuns).all();
  expect(waiting?.state).toBe("waiting");
  await rolling.drain();
  const runs = env.db.select().from(intelligenceRuns).all();
  expect(runs.map((r) => `${r.id} ${r.state}`)).toEqual([
    `${waiting?.id} valid`,
  ]);
  // The chapters answer was kept: asked once.
  expect(plans(model.calls)).toEqual([[0, 9]]);
  expect(rows().length).toBe(1);
});

test("at most one roll per conversation at a time; one asked meanwhile follows", async () => {
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  let running = 0;
  let most = 0;
  const respond = answer();
  const model = fakeModel(async (call) => {
    if (stageOf(call) === "chapters") {
      running += 1;
      most = Math.max(most, running);
      await gate;
      running -= 1;
    }
    return respond(call);
  });
  const rolling = rollingChapters(env.db, { mac: model, windowChars: 100_000 });
  block(0, 10, 100);
  const first = rolling.drain();
  await Bun.sleep(50);
  block(100, 10, 200);
  const more = [rolling.drain(), rolling.drain()];
  await Bun.sleep(50);
  expect(plans(model.calls).length).toBe(1);
  release();
  await Promise.all([first, ...more]);
  await rolling.idle();
  expect(most).toBe(1);
  expect(plans(model.calls)).toEqual([
    [0, 9],
    [5, 19],
  ]);
});

test("without the Mac nothing rolls", async () => {
  const rolling = rollingChapters(env.db, { mac: null });
  block(0, 10, 100);
  await rolling.drain();
  await rolling.drain();
  expect(env.db.select().from(intelligenceRuns).all()).toEqual([]);
});

test("a conversation is due whenever its words change, however late: an old one gets its summary when the Mac returns", async () => {
  const OLD = -3 * 86_400;
  let ready = false;
  let dropped = false;
  const respond = answer();
  const model = Object.assign(
    fakeModel((call) => {
      if (stageOf(call) === "chapter" && !dropped) {
        dropped = true;
        throw new MacGone("the Mac is away");
      }
      return respond(call);
    }),
    { ready: () => ready }
  );
  const rolling = rollingChapters(env.db, { mac: model, windowChars: 100_000 });
  // Three days ago, closed long since; its words come only now (held audio released).
  block(OLD, 10, 1000);
  expect(conversation()[0]?.closedAt).not.toBeNull();
  await rolling.drain();
  expect(model.calls.length).toBe(0);
  // The Mac comes, drops the roll, and comes back: it resumes and settles.
  ready = true;
  await rolling.drain();
  expect(env.db.select().from(intelligenceRuns).all()[0]?.state).toBe(
    "waiting"
  );
  await rolling.drain();
  expect(
    env.db
      .select()
      .from(intelligenceRuns)
      .all()
      .map((r) => r.state)
  ).toEqual(["valid"]);
  expect(rows().map((r) => r.title)).toEqual(["From 0", "From 5"]);
  // Read as they are: not due again.
  const calls = model.calls.length;
  await rolling.drain();
  expect(model.calls.length).toBe(calls);
});

test("a failed roll is tried again 5 minutes after it failed, then 10, 20, 40, then once an hour", () => {
  block(0, 3, 0);
  const [c] = env.db.select().from(conversations).all();
  if (!c) {
    throw new Error("no conversation");
  }
  // `n` failed runs, the last one `minutes` ago.
  const failed = (n: number, minutes: number) => {
    env.db.delete(intelligenceRuns).run();
    for (let i = 0; i < n; i += 1) {
      const created = new Date(Date.now() - minutes * 60_000 - (n - i) * 1000);
      env.db
        .insert(intelligenceRuns)
        .values({
          conversationId: c.id,
          createdAt: created,
          model: "m",
          promptVersion: PROMPT_VERSION,
          provider: "claude-code",
          state: "failed",
          turns: [],
          updatedAt: new Date(Date.now() - minutes * 60_000),
        })
        .run();
    }
  };
  const later = () => dueConversations(env.db, [c.id])[0]?.later;
  for (const [n, wait] of [
    [1, 5],
    [2, 10],
    [3, 20],
    [4, 40],
    [5, 60],
    [8, 60],
  ] as const) {
    failed(n, wait - 1);
    expect(later()).toBe(true);
    failed(n, wait + 1);
    expect(later()).toBe(false);
  }
});
