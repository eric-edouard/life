import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import {
  changeLog,
  conversations,
  events,
  heartbeatReasons,
  heartbeats,
  ownerEdits,
  sources,
  timelineSpans,
  transcriptionJobs,
} from "@lifelog/db/schema";
import { asc, eq } from "drizzle-orm";
import { createApp } from "./app";
import { conversationStates, type Inputs } from "./conversation-state";
import { feed } from "./feed";
import {
  anchorId,
  anchorOf,
  type Edit,
  type GroupingInput,
  groupSource,
  markDirty,
  type Range,
  regroupAfterCommit,
  regroupDirty,
  segment,
} from "./grouping";
import { services } from "./services";
import { setSwitches } from "./switches";
import {
  mapJob,
  OWNER_TOKEN,
  seedTranscript,
  testConfig,
  testDb,
} from "./testing";
import { setOwnerTitle } from "./titles";

// ---- The cases in apps/server/fixtures/segmentation ------------------------------------------

const BASE = 1_790_000_000_000;
const at = (s: number) => BASE + Math.round(s * 1000);
const r = ([a, b]: [number, number]): Range => [at(a), at(b)];

interface Case {
  audible?: [number, number][];
  capSplits?: number[];
  case: string;
  dictation?: [number, number][];
  edits?: {
    at?: number;
    from?: number;
    kind: "split" | "aiSplit" | "merge";
    to?: number;
    undone?: boolean;
  }[];
  expected: { end: number; id: string; start: number }[];
  locations?: {
    accuracyM: number;
    at: number;
    latitude: number;
    longitude: number;
  }[];
  pauses?: number[];
  previous?: number[];
  spans: { breaks: string[]; end: number; start: number }[];
  speech?: [number, number][];
  unanalyzed?: [number, number][];
  words?: [number, number][];
}

const dir = new URL("../fixtures/segmentation/", import.meta.url);
const cases = (
  await Promise.all(
    (
      await readdir(dir)
    )
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map(async (f) => (await Bun.file(new URL(f, dir)).json()) as Case[])
  )
).flat();

const editOf = (e: NonNullable<Case["edits"]>[number]): Edit[] => {
  if (e.undone) {
    return [];
  }
  return e.kind === "merge"
    ? [{ from: at(e.from ?? 0), kind: "merge", to: at(e.to ?? 0) }]
    : [{ ai: e.kind === "aiSplit", at: at(e.at ?? 0), kind: "split" }];
};

const NONE = {
  audible: [],
  dictation: [],
  edits: [],
  locations: [],
  pauses: [],
  previous: [],
  speech: [],
  unanalyzed: [],
  words: [],
};
const inputOf = (raw: Case): GroupingInput => {
  const c = { ...NONE, ...raw };
  return {
    audible: c.audible.map(r),
    dictation: c.dictation.map(r),
    edits: c.edits.flatMap(editOf),
    locations: c.locations.map((f) => ({ ...f, at: at(f.at) })),
    pauses: c.pauses.map(at),
    previous: c.previous.map(at),
    spans: c.spans.map((s) => ({ ...s, end: at(s.end), start: at(s.start) })),
    speech: c.speech.map(r),
    unanalyzed: c.unanalyzed.map(r),
    words: c.words.map(r),
  };
};

test("a group claims a live conversation's anchor before a retired one's", () => {
  const input: GroupingInput = {
    audible: [],
    dictation: [],
    edits: [],
    locations: [],
    pauses: [],
    previous: [at(5)],
    retired: [at(0)],
    spans: [{ breaks: [], end: at(60), start: at(0) }],
    speech: [r([0, 60])],
    unanalyzed: [],
    words: [],
  };
  expect(segment(input).conversations.map((g) => g.anchor)).toEqual([at(5)]);
  // With no live one to claim, the retired id comes back.
  expect(
    segment({ ...input, previous: [] }).conversations.map((g) => g.anchor)
  ).toEqual([at(0)]);
});

test("the shared segmentation cases are there", () => {
  expect(cases.length).toBeGreaterThanOrEqual(20);
});

test.each(cases.map((c) => [c.case, c] as const))(
  "segmentation: %s",
  (_, c) => {
    const { capSplits, conversations: grouped } = segment(inputOf(c));
    expect(
      grouped.map((g) => ({
        end: g.end,
        id: anchorId(g.anchor),
        start: g.start,
      }))
    ).toEqual(
      c.expected.map((e) => ({ ...e, end: at(e.end), start: at(e.start) }))
    );
    expect(capSplits).toEqual((c.capSplits ?? []).map(at));
  }
);

test("anchor ids are the phone's UUIDs, both ways", () => {
  expect(anchorId(0x01_a1_39_76_5b_01)).toBe(
    "00000000-0000-8000-8000-01a139765b01"
  );
  expect(anchorOf("00000000-0000-8000-8000-01a139765b01")).toBe(
    0x01_a1_39_76_5b_01
  );
  expect(anchorOf(randomUUID())).toBeNull();
});

// ---- Routes and the database ---------------------------------------------------

let env: Awaited<ReturnType<typeof testDb>>;
let app: ReturnType<typeof createApp>;
// The credits as the worker last read them.
let creditsOut = false;

beforeAll(() => {
  env = testDb();
  app = createApp(
    services(testConfig("http://localhost:1"), env.db, {
      intelligence: null,
      search: null,
    })
  );
});
afterAll(() => {
  env.drop();
});
beforeEach(() => {
  env.reset();
  creditsOut = false;
});

const SOURCE = "pendant-1";
const [HEARTBEAT_REASON = "periodic"] = heartbeatReasons;
const iso = (s: number) => new Date(at(s)).toISOString();
const send = (method: string, path: string, body?: object) =>
  app.request(path, {
    body: body ? JSON.stringify(body) : null,
    headers: {
      Authorization: `Bearer ${OWNER_TOKEN}`,
      "Content-Type": "application/json",
    },
    method,
  });

// One span per call, as the phone sends a continuous capture span.
const span = (
  firstPage: number,
  [start, end]: [number, number],
  speech: [number, number][],
  audible: [number, number][] = [[start, end]]
) => ({
  audible: audible.map(([a, b]) => [iso(a), iso(b)]),
  breaks: [],
  endAt: iso(end),
  firstPage,
  pauses: [],
  speech: speech.map(([a, b]) => [iso(a), iso(b)]),
  startAt: iso(start),
  unanalyzed: [],
});
const timeline = (heard: number, spans: ReturnType<typeof span>[]) =>
  send("PUT", `/sources/${SOURCE}/timeline`, {
    heardThrough: iso(heard),
    spans,
  });

const live = () =>
  env.db
    .select()
    .from(conversations)
    .orderBy(asc(conversations.captureStartedAt))
    .all()
    .filter((c) => c.retiredAt === null);
const ranges = () =>
  live().map((c) => [
    anchorOf(c.id),
    c.captureStartedAt.getTime(),
    c.captureEndedAt.getTime(),
  ]);
const logged = (id: string) =>
  env.db.select().from(changeLog).where(eq(changeLog.ref, id)).all().length;

test("recorded: whether a Pendant's audio falls in a range, and since when lifelog can tell", async () => {
  const asked = async (from: number, to: number) =>
    (await send("GET", `/recorded?from=${iso(from)}&to=${iso(to)}`)).json();
  expect(await asked(0, 100)).toEqual({ hasRecording: false, since: null });
  await timeline(400, [span(0, [100, 400], [])]);
  // An old-app recording is no Pendant's: it neither counts nor moves `since`.
  env.db.insert(sources).values({ id: "import:old" }).run();
  env.db
    .insert(timelineSpans)
    .values({
      endAt: new Date(at(-500)),
      facts: {
        audible: [],
        breaks: [],
        pauses: [],
        speech: [],
        unanalyzed: [],
      },
      firstPage: 0,
      sourceId: "import:old",
      startAt: new Date(at(-900)),
    })
    .run();
  const since = iso(100);
  expect(await asked(-1000, -400)).toEqual({ hasRecording: false, since });
  expect(await asked(0, 100)).toEqual({ hasRecording: false, since });
  expect(await asked(50, 150)).toEqual({ hasRecording: true, since });
  expect(await asked(400, 500)).toEqual({ hasRecording: false, since });
});

test("a timeline makes conversations with anchor ids, logged, closed once heard-through passes", async () => {
  const response = await timeline(200, [
    span(
      0,
      [0, 300],
      [
        [0, 60],
        [120, 180],
      ],
      []
    ),
  ]);
  expect(response.status).toBe(200);
  expect(ranges()).toEqual([
    [at(0), at(0), at(60)],
    [at(120), at(120), at(180)],
  ]);
  const [first, second] = live();
  expect(first?.closedAt).toBeNull();
  expect(logged(anchorId(at(0)))).toBe(1);
  // Heard-through only moves forward; 5 minutes past an end closes it.
  await timeline(400, []);
  await timeline(100, []);
  const [closed, open] = live();
  expect(closed?.closedAt).not.toBeNull();
  expect(open?.closedAt).toBeNull();
  expect(open?.id).toBe(second?.id);
  expect(logged(anchorId(at(0)))).toBe(2);
});

test("history is data: a handed-over conversation keeps its range under the phone's facts", async () => {
  // As the cutover wrote it: a span over [0, 600) the phone never
  // analyzed, under a negative page, and an AI split at its start.
  const history = [iso(0), iso(600)];
  env.db.insert(sources).values({ id: SOURCE }).run();
  env.db
    .insert(timelineSpans)
    .values({
      endAt: new Date(at(600)),
      facts: {
        audible: [history] as [string, string][],
        breaks: [],
        pauses: [],
        speech: [],
        unanalyzed: [history] as [string, string][],
      },
      firstPage: -at(0),
      sourceId: SOURCE,
      startAt: new Date(at(0)),
    })
    .run();
  // The phone's facts over the same stretch: speech, then 7 silent minutes, then speech.
  await timeline(1000, [
    span(
      0,
      [0, 600],
      [
        [0, 60],
        [480, 540],
      ]
    ),
  ]);
  expect(ranges()).toEqual([[at(0), at(0), at(600)]]);
});

test("late audio extends a closed conversation and keeps its id; one far later never touches it", async () => {
  await timeline(1000, [span(0, [0, 100], [[0, 100]])]);
  const [before] = live();
  expect(before?.closedAt).not.toBeNull();
  await timeline(1300, [span(100, [100, 200], [[120, 200]])]);
  expect(ranges()).toEqual([[at(0), at(0), at(200)]]);
  const logs = logged(anchorId(at(0)));
  // Ten minutes later: a new conversation, the closed one unwritten.
  await timeline(2000, [span(300, [800, 900], [[800, 900]])]);
  expect(ranges()).toEqual([
    [at(0), at(0), at(200)],
    [at(800), at(800), at(900)],
  ]);
  expect(logged(anchorId(at(0)))).toBe(logs);
});

test("a span sent again replaces the old one: a clock change regroups", async () => {
  await timeline(100, [span(0, [0, 300], [[10, 60]])]);
  await timeline(100, [span(0, [5, 305], [[15, 65]])]);
  // Within the anchor tolerance? No: 5 s. The new start makes a new id; the old retires to it.
  const all = env.db.select().from(conversations).all();
  expect(all.map((c) => anchorOf(c.id)).sort()).toEqual([at(10), at(15)]);
  const old = all.find((c) => anchorOf(c.id) === at(10));
  expect(old?.retiredAt).not.toBeNull();
  expect(old?.successorId).toBe(anchorId(at(15)));
});

test("a regroup logs only the turns whose conversation changed: a turn's conversation is never stale", async () => {
  // A job's turns at `start` (seconds), laid from there in capture time.
  const seed = (start: number, turns: number[]) => {
    const jobId = seedTranscript(
      env.db,
      turns.map((s) => ({
        end: s + 2,
        speakerId: "speaker_0",
        start: s,
        text: "Hello",
      }))
    );
    env.db
      .update(transcriptionJobs)
      .set({ sourceId: SOURCE })
      .where(eq(transcriptionJobs.id, jobId))
      .run();
    mapJob(env.db, jobId, [[at(start), at(start + 60)]]);
    env.db.$client.run("delete from change_log");
    return jobId;
  };
  const turnRefs = () =>
    env.db
      .select()
      .from(changeLog)
      .where(eq(changeLog.kind, "turn"))
      .all()
      .map((row) => row.ref)
      .sort();
  const first = seed(0, [0, 30]);
  await timeline(100, [span(0, [0, 300], [[0, 60]])]);
  expect(turnRefs()).toEqual([`${first}:0`, `${first}:1`]);
  // The open conversation grows over a later job: only its new turn is logged.
  const later = seed(90, [0]);
  await timeline(200, [
    span(
      0,
      [0, 300],
      [
        [0, 60],
        [90, 150],
      ]
    ),
  ]);
  expect(ranges()).toEqual([[at(0), at(0), at(150)]]);
  expect(turnRefs()).toEqual([`${later}:0`]);
  // A split logs the turns it moves to the new conversation, not the one that stays.
  env.db.$client.run("delete from change_log");
  await send("POST", "/edits", {
    at: iso(20),
    editedAt: iso(200),
    id: randomUUID(),
    kind: "split",
  });
  expect(turnRefs()).toEqual([`${first}:1`, `${later}:0`].sort());
  const page = feed(env.db, 0);
  expect(
    Object.fromEntries(
      page.turns.map((t) => [`${t.jobId}:${t.turnIndex}`, t.conversationId])
    )
  ).toEqual({
    [`${first}:1`]: anchorId(at(20)),
    [`${later}:0`]: anchorId(at(20)),
  });
});

test("split, merge and undo regroup, retire and bring back; edits are idempotent", async () => {
  await timeline(100, [
    span(
      0,
      [0, 800],
      [
        [0, 60],
        [400, 460],
      ]
    ),
  ]);
  expect(live().length).toBe(2);
  const merge = randomUUID();
  const body = {
    editedAt: new Date().toISOString(),
    from: iso(30),
    id: merge,
    kind: "merge",
    to: iso(430),
  };
  expect(await (await send("POST", "/edits", body)).json()).toEqual({
    stored: true,
  });
  expect(await (await send("POST", "/edits", body)).json()).toEqual({
    stored: false,
  });
  expect(ranges()).toEqual([[at(0), at(0), at(460)]]);
  const [merged] = env.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, anchorId(at(400))))
    .all();
  expect(merged?.successorId).toBe(anchorId(at(0)));

  const undo = {
    edit: merge,
    editedAt: new Date().toISOString(),
    id: randomUUID(),
    kind: "undo",
  };
  expect((await send("POST", "/edits", undo)).status).toBe(200);
  expect(ranges()).toEqual([
    [at(0), at(0), at(60)],
    [at(400), at(400), at(460)],
  ]);
  expect(
    (await send("POST", "/edits", { ...undo, edit: undo.id, id: randomUUID() }))
      .status
  ).toBe(400);
  expect(
    (
      await send("POST", "/edits", {
        ...undo,
        edit: randomUUID(),
        id: randomUUID(),
      })
    ).status
  ).toBe(404);

  const split = randomUUID();
  await send("POST", "/edits", {
    at: iso(30),
    editedAt: new Date().toISOString(),
    id: split,
    kind: "split",
  });
  expect(ranges().map(([id]) => id)).toEqual([at(0), at(30), at(400)]);
  await send("POST", "/edits", {
    edit: split,
    editedAt: new Date().toISOString(),
    id: randomUUID(),
    kind: "undo",
  });
  expect(ranges().map(([id]) => id)).toEqual([at(0), at(400)]);
  const [gone] = env.db
    .select()
    .from(conversations)
    .where(eq(conversations.id, anchorId(at(30))))
    .all();
  expect(gone?.successorId).toBe(anchorId(at(0)));
  expect(
    (
      await send("POST", "/edits", {
        editedAt: new Date().toISOString(),
        from: iso(50),
        id: randomUUID(),
        kind: "merge",
        to: iso(40),
      })
    ).status
  ).toBe(400);
});

test("a split or merge inside an imported recording is refused, not stored", async () => {
  await timeline(100, [span(0, [0, 100], [[0, 60]])]);
  env.db
    .insert(conversations)
    .values({
      captureEndedAt: new Date(at(1100)),
      captureStartedAt: new Date(at(1000)),
      id: randomUUID(),
      kind: "imported",
    })
    .run();
  const edit = (body: object) =>
    send("POST", "/edits", {
      editedAt: new Date().toISOString(),
      id: randomUUID(),
      ...body,
    });
  const refused = await Promise.all(
    [
      { at: iso(1050), kind: "split" },
      { from: iso(50), kind: "merge", to: iso(1050) },
      { from: iso(1000), kind: "merge", to: iso(1100) },
    ].map(edit)
  );
  expect(refused.map((res) => res.status)).toEqual([400, 400, 400]);
  expect(await refused[0]?.json()).toMatchObject({ error: "invalid_request" });
  expect(env.db.select().from(ownerEdits).all()).toEqual([]);
  // Outside it, a split is kept as always.
  expect((await edit({ at: iso(30), kind: "split" })).status).toBe(200);
});

test("over an hour with no boundary is cut at its longest pause, kept as an AI split", async () => {
  await timeline(100, [
    span(
      0,
      [0, 5000],
      [
        [0, 1000],
        [1010, 2000],
        [2030, 4000],
      ]
    ),
  ]);
  expect(ranges()).toEqual([
    [at(0), at(0), at(2000)],
    [at(2030), at(2030), at(4000)],
  ]);
  const edits = env.db.select().from(ownerEdits).all();
  expect(edits.map((e) => [e.source, e.at?.getTime()])).toEqual([
    ["ai", at(2015)],
  ]);
  // The next run reads it as an edit: no second cut.
  await timeline(100, [
    span(
      0,
      [0, 5000],
      [
        [0, 1000],
        [1010, 2000],
        [2030, 4000],
      ]
    ),
  ]);
  expect(env.db.select().from(ownerEdits).all().length).toBe(1);
});

// A first pass of the states (conversation-state.ts) looks at every conversation.
const refreshWaiting = (db: typeof env.db, inputs: Inputs, now?: Date) =>
  conversationStates(db, inputs).refresh(now);

const job = (start: number, end: number, state: "queued" | "completed") =>
  env.db
    .insert(transcriptionJobs)
    .values({
      audioSha256: randomUUID(),
      billableSeconds: 60,
      captureEnd: new Date(at(end)),
      captureStart: new Date(at(start)),
      preparedDurationSeconds: 60,
      settings: { keyterms: [], languageCode: null, numSpeakers: null },
      settingsHash: randomUUID(),
      sourceId: SOURCE,
      state,
    })
    .run();

test("kind: silent once every job over it is transcribed with no words", async () => {
  job(0, 60, "completed");
  await timeline(100, [span(0, [0, 300], [[0, 60]])]);
  expect(live().map((c) => c.kind)).toEqual(["silent"]);
});

test("waiting reasons follow what blocks the conversation", async () => {
  job(0, 60, "queued");
  await timeline(100, [span(0, [0, 300], [[0, 60]])]);
  const reason = () => live()[0]?.waitingReason;
  creditsOut = true;
  const deps = {
    creditsOut: () => creditsOut,
    macAble: () => true,
    macStuckSince: () => null,
  };
  refreshWaiting(env.db, deps);
  expect(reason()).toBe("creditsOut");
  expect(live()[0]?.state).toBe("uploaded");
  setSwitches(env.db, { transcription: false });
  refreshWaiting(env.db, deps);
  expect(reason()).toBe("transcriptionOff");
  setSwitches(env.db, { transcription: true });
  creditsOut = false;
  refreshWaiting(env.db, deps);
  expect(reason()).toBeNull();
  expect(live()[0]?.waitingSince).toBeNull();
});

test("a stuck Mac watermark shows macAway on the conversations it holds", async () => {
  await timeline(100, [span(0, [0, 300], [[0, 60]])]);
  const [conversation] = live();
  const end = conversation?.captureEndedAt.getTime() ?? 0;
  const deps = (stuck: Date | null) => ({
    creditsOut: () => false,
    macAble: () => true,
    macStuckSince: () => stuck,
  });
  const reason = () => live()[0]?.waitingReason;
  refreshWaiting(env.db, deps(new Date(end + 1000)));
  expect(reason()).toBeNull();
  refreshWaiting(env.db, deps(new Date(end - 1000)));
  expect(reason()).toBe("macAway");
  refreshWaiting(env.db, deps(null));
  expect(reason()).toBeNull();
});

test("forward-only: a change regroups up to the first closed conversation after it, never past", async () => {
  // Three conversations, closed.
  await timeline(2000, [
    span(
      0,
      [0, 1500],
      [
        [0, 60],
        [400, 460],
        [800, 860],
      ]
    ),
  ]);
  expect(live().map((c) => c.closedAt !== null)).toEqual([true, true, true]);
  // The last one's facts change under it, as a new policy would read them, without a regroup.
  env.db.$client.run(
    `update timeline_spans set facts = json_set(facts, '$.speech', json_insert(facts -> '$.speech', '$[#]', json('["${iso(870)}", "${iso(880)}"]')))`
  );
  const lastLogs = logged(anchorId(at(800)));
  // A split in the first: it and the one after regroup, the last stays as it was grouped.
  await send("POST", "/edits", {
    at: iso(30),
    editedAt: iso(2000),
    id: randomUUID(),
    kind: "split",
  });
  expect(ranges()).toEqual([
    [at(0), at(0), at(30)],
    [at(30), at(30), at(60)],
    [at(400), at(400), at(460)],
    [at(800), at(800), at(860)],
  ]);
  expect(logged(anchorId(at(800)))).toBe(lastLogs);
});

test("a change is kept dirty on its source until a regroup covers it; the tick runs what failed", () => {
  env.db.insert(sources).values({ id: SOURCE }).run();
  env.db
    .insert(timelineSpans)
    .values({
      endAt: new Date(at(300)),
      facts: {
        audible: [[iso(0), iso(300)]],
        breaks: [],
        pauses: [],
        speech: [[iso(0), iso(60)]],
        unanalyzed: [],
      },
      firstPage: 0,
      sourceId: SOURCE,
      startAt: new Date(at(0)),
    })
    .run();
  // Marked with the spans, then the regroup after it never ran (a crash, a deadlock).
  markDirty(env.db, [SOURCE], [at(0), at(300)]);
  expect(ranges()).toEqual([]);
  expect(regroupDirty(env.db)).toBe(1);
  expect(ranges()).toEqual([[at(0), at(0), at(60)]]);
  const [source] = env.db.select().from(sources).all();
  expect([source?.dirtyFrom, source?.dirtyTo]).toEqual([null, null]);
  expect(regroupDirty(env.db)).toBe(0);
});

test("a title edit while grouping runs: every writer logs last, so neither waits on the other", async () => {
  await timeline(100, [span(0, [0, 300], [[0, 60]])]);
  const [conversation] = live();
  const id = conversation?.id ?? "";
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      i % 2
        ? setOwnerTitle(env.db, id, `Title ${i}`)
        : Promise.resolve().then(() => {
            markDirty(env.db, [SOURCE], [at(0), at(300)]);
            return groupSource(env.db, SOURCE);
          })
    )
  );
  expect(live()[0]?.ownerTitle).toStartWith("Title");
});

test("a conversation names the edits that made its edges, for Undo", async () => {
  await timeline(100, [
    span(
      0,
      [0, 800],
      [
        [0, 60],
        [400, 460],
      ]
    ),
  ]);
  const split = randomUUID();
  await send("POST", "/edits", {
    at: iso(30),
    editedAt: iso(100),
    id: split,
    kind: "split",
  });
  const merge = randomUUID();
  await send("POST", "/edits", {
    editedAt: iso(101),
    from: iso(40),
    id: merge,
    kind: "merge",
    to: iso(430),
  });
  const { conversations: rows } = feed(env.db, 0);
  const edges = (start: number) => {
    const row = rows.find((c) => c.id === anchorId(at(start)));
    return [row?.startEdit, row?.endEdit];
  };
  expect(edges(0)).toEqual([null, split]);
  expect(edges(30)).toEqual([split, null]);
  // Undo the split: the merged one names the merge.
  await send("POST", "/edits", {
    edit: split,
    editedAt: iso(102),
    id: randomUUID(),
    kind: "undo",
  });
  const after = feed(env.db, 0).conversations.find(
    (c) => c.id === anchorId(at(0)) && c.retired === null
  );
  expect([after?.startEdit, after?.endEdit]).toEqual([merge, null]);
});

test("phoneQuiet only while the conversation's own audio is behind", async () => {
  const deps = {
    creditsOut: () => false,
    macAble: () => true,
    macStuckSince: () => null,
  };
  env.db
    .insert(heartbeats)
    .values({
      body: { recording: { state: "recording" } },
      id: randomUUID(),
      observedAt: new Date(),
      reason: HEARTBEAT_REASON,
    })
    .run();
  const reason = () => live()[0]?.waitingReason;
  // Heard through 1:00 of a conversation that goes on to 3:20, and nothing since.
  await timeline(60, [span(0, [0, 300], [[0, 200]])]);
  refreshWaiting(env.db, deps, new Date(at(60) + 20 * 60_000));
  expect(reason()).toBe("phoneQuiet");
  // Every word of it heard: it waits for nothing of the phone's.
  await timeline(250, []);
  refreshWaiting(env.db, deps, new Date(at(250) + 20 * 60_000));
  expect(reason()).toBeNull();
});

test("a regroup that throws is recorded, and its range stays dirty for the tick", () => {
  const { db } = env;
  const from = at(0);
  db.insert(sources).values({ id: "broken" }).run();
  markDirty(db, ["broken"], [from, from + 60_000]);
  // Facts no grouping can read.
  db.insert(timelineSpans)
    .values({
      endAt: new Date(from + 60_000),
      facts: { speech: 5 } as never,
      firstPage: 0,
      sourceId: "broken",
      startAt: new Date(from),
    })
    .run();
  regroupAfterCommit(db, ["broken"]);
  const failed = db
    .select()
    .from(events)
    .where(eq(events.name, "grouping.failed"))
    .all();
  expect(failed.map((e) => e.fields)).toEqual([{ source: "broken" }]);
  const source = db
    .select()
    .from(sources)
    .where(eq(sources.id, "broken"))
    .get();
  expect(source?.dirtyFrom?.getTime()).toBe(from);
});
