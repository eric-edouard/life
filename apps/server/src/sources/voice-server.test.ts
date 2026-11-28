import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { Push } from "../core/push";
import { AppleHealthPage } from "./apple-health";
import { VoiceNoteWords } from "./chat-voice-notes";
import {
  conversation,
  pageFixture,
  voiceStore as store,
  turnFixture,
  voiceServer,
} from "./store-fixtures";
import {
  apply,
  newestTurn,
  openStore,
  ownerSpoke,
  Page,
  poll,
  readConversations,
  readPhoneZone,
  Stays,
  speakers,
  storeFiles,
  Transcript,
  turnPlace,
  turnsBetween,
  VoiceServerStatus,
  visits,
  writeMarks,
} from "./voice-server";
import { conversationsWith } from "./voice-server-conversations";
import { Recorded } from "./voice-server-recorded";
import { Hits, searchVoice } from "./voice-server-search";
import { endedOnSilence, isConversationClosed } from "./voice-server-speech";
import { VoiceSpending } from "./voice-server-spending";
import {
  Clip,
  ConversationAnswer,
  NamingQueueItem,
  Voices,
  voiceNamesOf,
} from "./voice-speakers";

const since = new Date("2026-10-01T00:00:00Z");
const JEAN = "person-jean";
const ANNE = "person-anne";

test("a name given to one turn names that turn, not the whole voice", () => {
  const s = store();
  // Voice speaker_0 is unnamed; the owner named only turn 1. The server sends each turn with the name that wins for it.
  apply(
    s,
    pageFixture({
      conversations: [conversation("c1")],
      turns: [
        turnFixture(0, "2026-10-14T10:00:00.000Z", null, null),
        turnFixture(1, "2026-10-14T10:01:00.000Z", ANNE, "Anne-Sophie"),
        turnFixture(2, "2026-10-14T10:02:00.000Z", null, null),
        turnFixture(3, "2026-10-14T10:06:00.000Z", null, null),
      ],
    })
  );
  const [c] = readConversations(s, since);
  expect(c?.turns.map((t) => t.name)).toEqual([
    null,
    "Anne-Sophie",
    null,
    null,
  ]);
  expect(
    turnsBetween(
      s,
      "c1",
      "2026-10-14T10:00:00.000Z",
      "2026-10-14T10:05:00.000Z"
    ).map((t) => t.name)
  ).toEqual([null, "Anne-Sophie", null]);
});

test("a turn is his while the store credits him now: one lifelog later names someone else, or no one, is not", () => {
  const s = store();
  const at = "2026-10-14T10:00:00.000Z";
  const ref = `job-1:0@${at}`;
  const sent = (owner: boolean, id: string | null) =>
    apply(
      s,
      pageFixture({
        conversations: [conversation("c1")],
        turns: [turnFixture(0, at, id, id, "c1", owner)],
      })
    );
  sent(true, JEAN);
  expect(ownerSpoke(s, ref)).toBe(true);
  sent(false, ANNE);
  expect(ownerSpoke(s, ref)).toBe(false);
  sent(false, null);
  expect(ownerSpoke(s, ref)).toBe(false);
  expect(ownerSpoke(s, "msg-1")).toBe(false);
});

test("a conversation holds its turns, in order, with the names the directory gives its people", () => {
  const s = store();
  apply(
    s,
    pageFixture({
      conversations: [conversation("c1")],
      turns: [
        turnFixture(1, "2026-10-14T10:04:00.000Z", ANNE, "Anne-Sophie"),
        turnFixture(0, "2026-10-14T10:00:00.000Z", JEAN, "Jean (Me)"),
      ],
    })
  );
  const [c] = readConversations(s, since, new Map([[JEAN, "Jean Dupont"]]));
  expect(c?.id).toBe("c1");
  expect(c?.turns.map((t) => [t.turnIndex, t.name])).toEqual([
    [0, "Jean Dupont"],
    [1, "Anne-Sophie"],
  ]);
});

test("a conversation with words is read whatever its state, with its state and lifelog's closed; a silent one is not", () => {
  const s = store();
  apply(
    s,
    pageFixture({
      conversations: [
        conversation("c1", { closed: true }),
        conversation("c2", { state: "transcribing" }),
        conversation("c4"),
      ],
      turns: [
        turnFixture(0, "2026-10-14T10:00:00.000Z", null, null, "c1"),
        turnFixture(1, "2026-10-14T10:01:00.000Z", null, null, "c2"),
      ],
    })
  );
  expect(readConversations(s, since).map((c) => [c.id, c.closed])).toEqual([
    ["c1", true],
    // Still transcribing: read all the same, its units stay while late audio reopens it.
    ["c2", false],
  ]);
});

test("a retired conversation is not read, its successor is; removed rows go", () => {
  const s = store();
  apply(
    s,
    pageFixture({
      conversations: [
        conversation("c1"),
        conversation("c0", { retired: { successorId: "c1" } }),
        conversation("s1", { kind: "silent" }),
      ],
      turns: [
        turnFixture(0, "2026-10-14T10:00:00.000Z", null, null),
        turnFixture(1, "2026-10-14T10:06:00.000Z", null, null),
        turnFixture(2, "2026-10-14T10:07:00.000Z", null, null, "c0"),
      ],
    })
  );
  expect(readConversations(s, since).map((x) => x.id)).toEqual(["c1"]);
  apply(s, pageFixture({ removed: [{ kind: "turn", ref: "job-1:1" }] }));
  const [c] = readConversations(s, since);
  expect(c?.turns.map((t) => t.turnIndex)).toEqual([0]);
  apply(s, pageFixture({ removed: [{ kind: "conversation", ref: "c1" }] }));
  expect(readConversations(s, since)).toEqual([]);
});

test("applying a page twice changes nothing, and an empty store is no conversations", () => {
  const s = store();
  expect(readConversations(s, since)).toEqual([]);
  const p = pageFixture({
    conversations: [conversation("c1")],
    turns: [turnFixture(0, "2026-10-14T10:00:00.000Z", null, null)],
  });
  apply(s, p);
  const once = JSON.stringify(readConversations(s, since));
  expect(apply(s, p)).toEqual(new Date("2026-10-14T10:00:00.000Z"));
  expect(JSON.stringify(readConversations(s, since))).toBe(once);
  expect(apply(s, pageFixture())).toBeNull();
});

test("a page touches from the earliest start it writes or replaces: a conversation moved later touches its old start; a row never stored, nothing", () => {
  const s = store();
  const on = (at: string) =>
    pageFixture({
      conversations: [conversation("c1", { startAt: at })],
      turns: [turnFixture(0, at, null, null)],
    });
  expect(apply(s, on("2026-10-14T10:00:00.000Z"))).toEqual(
    new Date("2026-10-14T10:00:00.000Z")
  );
  expect(apply(s, on("2026-10-16T10:00:00.000Z"))).toEqual(
    new Date("2026-10-14T10:00:00.000Z")
  );
  expect(
    apply(s, pageFixture({ removed: [{ kind: "turn", ref: "job-9:0" }] }))
  ).toBeNull();
  expect(
    apply(s, pageFixture({ removed: [{ kind: "conversation", ref: "c1" }] }))
  ).toEqual(new Date("2026-10-16T10:00:00.000Z"));
});

test("a turn's place in its conversation, and a person's conversations newest first", () => {
  const s = store();
  apply(
    s,
    pageFixture({
      conversations: [
        conversation("c1"),
        conversation("c2", { startAt: "2026-10-15T09:00:00.000Z" }),
        conversation("c3", { kind: "silent" }),
      ],
      turns: [
        turnFixture(0, "2026-10-14T10:00:00.000Z", null, null),
        turnFixture(1, "2026-10-14T10:01:00.000Z", ANNE, "Anne-Sophie"),
        turnFixture(2, "2026-10-14T10:02:00.000Z", ANNE, "Anne-Sophie"),
        turnFixture(0, "2026-10-15T09:00:00.000Z", ANNE, "Anne-Sophie", "c2"),
        turnFixture(0, "2026-10-15T09:00:00.000Z", ANNE, "Anne-Sophie", "c3"),
      ].map((t) => ({ ...t, jobId: `job-${t.conversationId?.slice(1)}` })),
    })
  );
  expect(turnPlace(s, "job-1", 0)).toEqual({ conversation: "c1", offset: 0 });
  expect(turnPlace(s, "job-1", 2)).toEqual({ conversation: "c1", offset: 2 });
  expect(turnPlace(s, "job-1", 9)).toBeNull();
  const named = (byId: Map<string, string>) =>
    conversationsWith(s, [ANNE], byId).map((c) => [c.id, c.names]);
  // The directory's name beats the one the voice server gave, as in a unit's label.
  expect(named(new Map([[ANNE, "Anne Directory"]]))).toEqual([
    ["c2", ["Anne Directory"]],
    ["c1", ["Anne Directory"]],
  ]);
  expect(named(new Map())).toEqual([
    ["c2", ["Anne-Sophie"]],
    ["c1", ["Anne-Sophie"]],
  ]);
  expect(conversationsWith(s, [ANNE, "nobody"], new Map())).toHaveLength(2);
  expect(speakers(s)).toEqual([{ id: ANNE, name: "Anne-Sophie" }]);
});

test("search posts the words and the range with the device token and returns the hits", async () => {
  const server = voiceServer({
    "/search": () => ({
      hits: [
        {
          capturedFrom: "2026-10-14T10:00:00.000Z",
          conversationId: "c1",
          firstTurn: 1,
          jobId: "job-1",
          lastTurn: 2,
          score: 0.9,
          speakers: ["Anne-Sophie"],
          text: "Anne-Sophie: la vitre",
        },
      ],
    }),
  });
  try {
    const hits = await searchVoice(
      "vitre",
      { from: "2026-10-14T00:00:00.000Z" },
      10
    );
    expect(hits.map((h) => h.text)).toEqual(["Anne-Sophie: la vitre"]);
    expect(server.seen).toEqual([
      {
        auth: "Bearer test-token",
        body: {
          dateRange: { from: "2026-10-14T00:00:00.000Z" },
          limit: 10,
          query: "vitre",
        },
        path: "/search",
      },
    ]);
  } finally {
    server.close();
  }
});

test("the owner flag is stored and read back; poll lists a turn as his once, a late identification included", async () => {
  const s = store();
  const anne = turnFixture(1, "2026-10-14T10:01:00.000Z", ANNE, "Anne-Sophie");
  let first = turnFixture(
    0,
    "2026-10-14T10:00:00.000Z",
    ANNE,
    "Anne-Sophie",
    "c1"
  );
  const server = voiceServer({
    "/changes": () =>
      pageFixture({
        conversations: [conversation("c1")],
        turns: [first, anne],
      }),
  });
  try {
    expect((await poll(s, 0)).owner).toEqual([]);
    first = turnFixture(
      0,
      "2026-10-14T10:00:00.000Z",
      JEAN,
      "Jean (Me)",
      "c1",
      true
    );
    expect((await poll(s, 0)).owner).toEqual([
      { at: "2026-10-14T10:00:00.000Z", conversation: "c1" },
    ]);
    expect(turnsBetween(s, "c1").map((t) => t.owner)).toEqual([true, false]);
    expect((await poll(s, 0)).owner).toEqual([]);
  } finally {
    server.close();
  }
});

test("a turn keeps its end and when the feed first brought it", () => {
  const s = store();
  const words = {
    ...turnFixture(0, "2026-10-14T10:00:00.000Z", null, null),
    endAt: "2026-10-14T10:00:04.000Z",
  };
  apply(
    s,
    Page.parse(pageFixture({ turns: [words] })),
    "2026-10-14T10:01:00.000Z"
  );
  const named = {
    ...words,
    speaker: { isOwner: true, personId: JEAN, personName: "Jean (Me)" },
  };
  apply(
    s,
    Page.parse(pageFixture({ turns: [named] })),
    "2026-10-14T10:01:01.000Z"
  );
  expect(turnsBetween(s, "c1")).toMatchObject([
    {
      end: "2026-10-14T10:00:04.000Z",
      owner: true,
      seen: "2026-10-14T10:01:00.000Z",
    },
  ]);
});

test("poll also lists a new turn nobody is named for, once", async () => {
  const s = store();
  const lost = turnFixture(0, "2026-10-14T10:00:00.000Z", null, null, "c1");
  const server = voiceServer({
    "/changes": () =>
      pageFixture({ conversations: [conversation("c1")], turns: [lost] }),
  });
  try {
    expect((await poll(s, 0)).owner).toEqual([
      { at: "2026-10-14T10:00:00.000Z", conversation: "c1" },
    ]);
    expect((await poll(s, 0)).owner).toEqual([]);
  } finally {
    server.close();
  }
});

test("a store made before the contract's closed and endedOnSilence opens, drops its old jobs table and reads both", () => {
  const dir = mkdtempSync(join(tmpdir(), "life-lifelog-"));
  try {
    const old = new Database(storeFiles(dir).file);
    old.run(`create table conversations (
      id text primary key, start_at text not null, end_at text not null, kind text not null, state text not null,
      title text not null, successor text);
    create table jobs (id text primary key, speech_seconds real not null);`);
    old.close();
    const upgraded = openStore(dir);
    apply(
      upgraded,
      Page.parse(
        pageFixture({
          conversations: [conversation("c1", { closed: true })],
          jobs: [{ endedOnSilence: true, id: "job-1" }],
        })
      )
    );
    expect(isConversationClosed(upgraded, "c1")).toBe(true);
    expect(endedOnSilence(upgraded, "job-1")).toBe(true);
    expect(
      upgraded.db
        .query("select name from sqlite_master where name = 'jobs'")
        .get()
    ).toBeNull();
    upgraded.db.close();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

// The voice server's published contract, in this repo, kept current by the gate's openapi step.
const CONTRACT = join(
  import.meta.dir,
  "../../../lifelog/apps/server/openapi.json"
);

interface Json {
  $ref?: string;
  allOf?: Json[];
  anyOf?: Json[];
  const?: unknown;
  enum?: unknown[];
  items?: Json;
  oneOf?: Json[];
  properties?: Record<string, Json>;
  required?: string[];
  type?: string | string[];
}

/** A schema's alternatives as plain schemas: refs followed, each `oneOf` branch apart, `allOf` parts merged into each. */
function branchesOf(s: Json, defs: Record<string, Json>): Json[] {
  if (s.$ref) {
    const target = defs[s.$ref.split("/").at(-1) ?? ""] ?? {};
    return branchesOf(target, defs);
  }
  if (s.oneOf) {
    return s.oneOf.flatMap((b) => branchesOf(b, defs));
  }
  return s.allOf
    ? s.allOf.reduce<Json[]>(
        (held, part) =>
          held.flatMap((h) =>
            branchesOf(part, defs).map((b) => ({
              ...h,
              ...b,
              properties: { ...h.properties, ...b.properties },
              required: [...(h.required ?? []), ...(b.required ?? [])],
            }))
          ),
        [{}]
      )
    : [s];
}
const valuesOf = (s?: Json) =>
  s?.enum ?? (s && "const" in s ? [s.const] : undefined);

/**
 * Where Life's schema would refuse what the contract allows: a null it does not take, a field it needs that may be
 * absent, a value it does not list, a kind of a union (told apart by `kind`) none of its branches reads.
 */
function drift(
  life: Json,
  theirs: Json,
  defs: Record<string, Json>,
  at = ""
): string[] {
  const nullable = (s: Json) =>
    [s.type].flat().includes("null") ||
    !!s.anyOf?.some((x) => x.type === "null");
  const nonNull = (s: Json) => s.anyOf?.find((x) => x.type !== "null") ?? s;
  const kinds = branchesOf(nonNull(theirs), defs);
  const [t = {}] = kinds;
  const l = nonNull(life);
  const out =
    (nullable(theirs) || nullable(t)) && life.type && !nullable(life)
      ? [`${at}: null`]
      : [];
  if (kinds.length > 1) {
    const mine = branchesOf(l, {});
    return [
      ...out,
      ...kinds.flatMap((theirKind) => {
        const [kind] = valuesOf(theirKind.properties?.kind) ?? [];
        const reader = mine.find((b) =>
          valuesOf(b.properties?.kind)?.includes(kind)
        );
        return reader
          ? drift(reader, theirKind, defs, `${at}(${kind})`)
          : [`${at}: ${kind} not read`];
      }),
    ];
  }
  const read = valuesOf(l);
  if (read) {
    out.push(
      ...(valuesOf(t) ?? ["any value"])
        .filter((v) => !read.includes(v))
        .map((v) => `${at}: ${v} not read`)
    );
  }
  for (const [k, v] of Object.entries(l.properties ?? {})) {
    const theirsK = t.properties?.[k];
    if (!theirsK) {
      out.push(`${at}.${k}: not in the contract`);
      continue;
    }
    if (l.required?.includes(k) && !t.required?.includes(k)) {
      out.push(`${at}.${k}: may be absent`);
    }
    out.push(...drift(v, theirsK, defs, `${at}.${k}`));
  }
  return l.items && t.items
    ? [...out, ...drift(l.items, t.items, defs, `${at}[]`)]
    : out;
}

test("Life reads lifelog's API with the contract's nullability: a field lifelog may send null or leave out never stops the watcher", async () => {
  const api = await Bun.file(CONTRACT).json();
  const answer = (path: string, method: string) =>
    api.paths[path][method].responses["200"].content["application/json"].schema;
  const ours = (s: z.ZodType) =>
    z.toJSONSchema(s, { io: "input", unrepresentable: "any" }) as Json;
  const defs = api.components.schemas;
  expect([
    ...drift(ours(Page), answer("/changes", "get"), defs, "changes"),
    ...drift(
      ours(Transcript),
      answer("/transcription-jobs/{id}/transcript", "get"),
      defs,
      "transcript"
    ),
    ...drift(
      ours(ConversationAnswer),
      answer("/conversations/{id}", "get"),
      defs,
      "conversation"
    ),
    ...drift(ours(Voices), answer("/speakers/voices", "get"), defs, "voices"),
    ...drift(
      ours(z.array(NamingQueueItem)),
      answer("/naming-queue", "get"),
      defs,
      "naming-queue"
    ),
    ...drift(ours(Clip), answer("/turns/clip", "get"), defs, "turns-clip"),
    ...drift(ours(Hits), answer("/search", "post"), defs, "search"),
    ...drift(ours(Recorded), answer("/recorded", "get"), defs, "recorded"),
    ...drift(ours(VoiceSpending), answer("/spending", "get"), defs, "spending"),
    ...drift(
      ours(VoiceNoteWords),
      answer("/voice-notes/transcript", "post"),
      defs,
      "voice-notes"
    ),
    ...drift(ours(Stays), answer("/visits", "get"), defs, "visits"),
    ...drift(ours(Stays), answer("/where", "get"), defs, "where"),
    ...drift(
      ours(AppleHealthPage),
      answer("/apple-health", "get"),
      defs,
      "apple-health"
    ),
    // Not /status: its contract leaves pendant and phoneHeartbeat untyped, so VoiceServerStatus takes each field as
    // optional and nullable (tested below) and there is nothing to compare.
  ]).toEqual([]);
});

test("a feed page with a turn not yet in a conversation and a conversation retired with no successor is read", () => {
  const p = Page.parse(
    pageFixture({
      conversations: [conversation("c1", { retired: { successorId: null } })],
      turns: [turnFixture(0, "2026-10-14T10:00:00.000Z", null, null, null)],
    })
  );
  expect(p.turns).toEqual([]);
  const s = store();
  apply(s, p);
  expect(() => readConversations(s, since)).not.toThrow();
  expect(readConversations(s, since)).toEqual([]);
});

test("a feed page parses with or without lifelog's generated title, and a store made with a title column drops it", () => {
  for (const extra of [{}, { ownerTitle: null, title: "Plumber" }]) {
    expect(
      Page.parse(pageFixture({ conversations: [conversation("c1", extra)] }))
        .conversations[0]?.id
    ).toBe("c1");
  }
  const dir = mkdtempSync(join(tmpdir(), "life-lifelog-"));
  try {
    const old = new Database(storeFiles(dir).file);
    old.run(`create table conversations (
      id text primary key, start_at text not null, end_at text not null, kind text not null, state text not null,
      title text not null, successor text, closed integer)`);
    old.close();
    const upgraded = openStore(dir);
    apply(
      upgraded,
      Page.parse(pageFixture({ conversations: [conversation("c1")] }))
    );
    expect(readConversations(upgraded, since)).toEqual([]);
    expect(
      upgraded.db
        .query(
          "select 1 from pragma_table_info('conversations') where name = 'title'"
        )
        .get()
    ).toBeNull();
    upgraded.db.close();
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("visits: lifelog's 404 (no place the phone named matches) is no stays", async () => {
  // No route: the test server answers 404, as the voice server does when nothing matches.
  const server = voiceServer({});
  try {
    expect(await visits({ place: "Nowhere" })).toEqual([]);
  } finally {
    server.close();
  }
});

test("a turn holds the marks whose wake it is, as lifelog has the turn now: regrouped, named or gone", () => {
  const s = store();
  const R0 = "job-1:0@2026-10-14T10:01:00.000Z";
  const R1 = "job-1:1@2026-10-14T10:06:00.000Z";
  const cut = (id: string) =>
    pageFixture({
      conversations: [conversation(id)],
      turns: [
        turnFixture(0, "2026-10-14T10:01:00.000Z", null, null, id, true),
        turnFixture(1, "2026-10-14T10:06:00.000Z", null, null, id),
      ],
    });
  apply(s, cut("c1"));
  writeMarks(s, "c1", "", [[R0, "r0b"], [R1]]);
  const marked = (id: string) =>
    readConversations(s, since)
      .find((c) => c.id === id)
      ?.turns.map((t) => t.marks);
  expect(marked("c1")).toEqual([[R0, "r0b"], [R1]]);
  // Regrouped into c2: the marks follow their turns. Heard again with no mark from 10:05: that one goes.
  apply(s, cut("c2"));
  expect(marked("c2")).toEqual([[R0, "r0b"], [R1]]);
  writeMarks(s, "c2", "2026-10-14T10:05:00.000Z", []);
  expect(marked("c2")).toEqual([[R0, "r0b"], []]);
  // Heard again unchanged: nothing to rebuild.
  expect(writeMarks(s, "c2", "", [[R0, "r0b"]])).toBe(false);
  // The voice server transcribed the recording again: another turn at the same index (a new start) is not the wake.
  apply(
    s,
    pageFixture({
      turns: [
        turnFixture(0, "2026-10-14T10:02:00.000Z", null, null, "c2", true),
      ],
    })
  );
  expect(marked("c2")).toEqual([[], []]);
  apply(
    s,
    pageFixture({
      turns: [
        turnFixture(0, "2026-10-14T10:01:00.000Z", null, null, "c2", true),
      ],
    })
  );
  // The voice server names someone else for the wake turn: no longer his mark.
  apply(
    s,
    pageFixture({
      turns: [
        turnFixture(0, "2026-10-14T10:01:00.000Z", ANNE, "Anne-Sophie", "c2"),
      ],
    })
  );
  expect(marked("c2")).toEqual([[], []]);
});

test("a hearing replaces only the marks of turns holding a wake it knows: an older wake's mark stays", () => {
  const s = store();
  const R0 = "job-1:0@2026-10-14T10:01:00.000Z";
  const R1 = "job-1:1@2026-10-14T10:06:00.000Z";
  apply(
    s,
    pageFixture({
      conversations: [conversation("c1")],
      turns: [
        turnFixture(0, "2026-10-14T10:01:00.000Z", null, null, "c1", true),
        turnFixture(1, "2026-10-14T10:06:00.000Z", null, null, "c1", true),
      ],
    })
  );
  writeMarks(s, "c1", "", [[R0], [R1]]);
  // Heard again: only R1 holds a wake the hearing knows ("hey Life"); R0 was a "hey <agent>" before 21 Nov 2026.
  writeMarks(s, "c1", "", [], [R1]);
  expect(
    readConversations(s, since)
      .find((c) => c.id === "c1")
      ?.turns.map((t) => t.marks)
  ).toEqual([[R0], []]);
});

test("lifelog's /status is read whatever its untyped objects hold: absent, null, or partly there", () => {
  expect(VoiceServerStatus.parse({})).toEqual({});
  expect(
    VoiceServerStatus.parse({ other: 1, pendant: null, phoneHeartbeat: null })
  ).toEqual({
    pendant: null,
    phoneHeartbeat: null,
  });
  expect(
    VoiceServerStatus.parse({
      pendant: { batteryPercent: 0, connection: null, recording: "recording" },
      phoneHeartbeat: { backlog: null },
    }).pendant?.batteryPercent
  ).toBe(0);
});

test("the phone's zone: a zone Intl knows, from the voice server's newest heartbeat; none, an offset or the voice server not set up, null; the voice server down, throws", async () => {
  // Days old still counts: the phone's latest zone is where he is.
  let beat: unknown = {
    observedAt: "2026-09-01T11:00:00.000Z",
    timeZone: "Asia/Jakarta",
  };
  const server = voiceServer({ "/status": () => ({ phoneHeartbeat: beat }) });
  try {
    expect(await readPhoneZone()).toBe("Asia/Jakarta");
    beat = { observedAt: "2026-10-21T11:00:00.000Z", timeZone: "+07:00" };
    expect(await readPhoneZone()).toBeNull();
    beat = { observedAt: "2026-10-21T11:00:00.000Z" };
    expect(await readPhoneZone()).toBeNull();
    beat = null;
    expect(await readPhoneZone()).toBeNull();
    // An answer it can't read is the voice server unreadable: a throw, never a guess.
    beat = "not a heartbeat";
    await expect(readPhoneZone()).rejects.toThrow();
  } finally {
    server.close();
  }
  // Set up nowhere: no phone to read, so no throw.
  const token = process.env.LIFELOG_TOKEN;
  delete process.env.LIFELOG_TOKEN;
  try {
    expect(await readPhoneZone()).toBeNull();
  } finally {
    if (token !== undefined) {
      process.env.LIFELOG_TOKEN = token;
    }
  }
});

test("the phone's zone comes from a field lifelog's heartbeat contract holds: `timeZone`", async () => {
  // `/status` leaves `phoneHeartbeat` untyped, so the drift check above can't see it: the heartbeat's own schema can.
  const api = JSON.parse(await Bun.file(CONTRACT).text());
  const beat = api.components.schemas.HeartbeatUpload.properties;
  expect(beat.timeZone.type).toBe("string");
  expect(
    VoiceServerStatus.parse({ phoneHeartbeat: { timeZone: "Asia/Jakarta" } })
      .phoneHeartbeat
  ).toEqual({ timeZone: "Asia/Jakarta" });
});

test("the newest turn is read without creating or changing the store: no store, no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-newest-turn-"));
  expect(await newestTurn(join(dir, "watch"))).toBeNull();
  expect(existsSync(join(dir, "watch"))).toBe(false);
  rmSync(dir, { force: true, recursive: true });
});

test("the name lifelog gave a person id is the newest one, and no name leaves the id out", () => {
  const names = voiceNamesOf([
    { at: "2026-10-02T00:00:00.000Z", id: "p1", name: "Dana" },
    { at: "2026-10-01T00:00:00.000Z", id: "p1", name: "Dani" },
    { at: "2026-10-03T00:00:00.000Z", id: "p1", name: null },
    { at: "2026-10-01T00:00:00.000Z", id: "p2", name: null },
  ]);
  expect([...names]).toEqual([["p1", "Dana"]]);
});

/** What a push may never carry (SECURITY.md): words, or a badge. */
const NOT_A_PUSH = /"(badge|body|title)"/;

test("a push Life asks the voice server for is the contract's: every kind read, its ids, and no word at all", async () => {
  const api = await Bun.file(CONTRACT).json();
  const theirs =
    api.paths["/notifications"].post.requestBody.content["application/json"]
      .schema;
  expect(
    drift(
      z.toJSONSchema(Push, { io: "input", unrepresentable: "any" }) as Json,
      theirs,
      api.components.schemas,
      "push"
    )
  ).toEqual([]);
  // It goes through Apple (SECURITY.md): a push is its kind, its ids and its level, never a word of his or Life's.
  expect(JSON.stringify(theirs)).not.toMatch(NOT_A_PUSH);
});
