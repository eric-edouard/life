import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  apply,
  conversationsWith,
  endedOnSilence,
  Hits,
  isConversationClosed,
  LifelogStatus,
  newestTurn,
  openStore,
  ownerSpoke,
  Page,
  poll,
  readConversations,
  Stays,
  searchVoice,
  speakers,
  storeFiles,
  Transcript,
  turnPlace,
  turnsBetween,
  visits,
  writeMarks,
} from "./lifelog";
import {
  chapter,
  conversation,
  lifelogServer,
  pageFixture,
  lifelogStore as store,
  turnFixture,
} from "./store-fixtures";

const since = new Date("2026-10-01T00:00:00Z");
const JEAN = "person-jean";
const ANNE = "person-anne";

test("a name given to one turn names that turn, not the whole voice", () => {
  const s = store();
  // Voice speaker_0 is unnamed; the owner named only turn 1. The server sends each turn with the name that wins for it.
  apply(
    s,
    pageFixture({
      chapters: [
        chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
        chapter("b", "2026-10-14T10:05:00.000Z", "2026-10-14T10:10:00.000Z"),
      ],
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
  expect(c?.chapters.map((h) => h.people)).toEqual([["Anne-Sophie"], []]);
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

test("a chapter holds its turns, its first turn's ref, and names the map gives its people", () => {
  const s = store();
  apply(
    s,
    pageFixture({
      chapters: [
        chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
        chapter("b", "2026-10-14T10:05:00.000Z", "2026-10-14T10:10:00.000Z"),
      ],
      conversations: [conversation("c1", { ownerTitle: "Plumber visit" })],
      turns: [
        turnFixture(0, "2026-10-14T10:00:00.000Z", JEAN, "Jean (Me)"),
        turnFixture(1, "2026-10-14T10:04:00.000Z", ANNE, "Anne-Sophie"),
        turnFixture(2, "2026-10-14T10:05:00.000Z", ANNE, "Anne-Sophie"),
      ],
    })
  );
  const [c] = readConversations(s, since, new Map([[JEAN, "Jean Dupont"]]));
  expect(c?.title).toBe("Plumber visit");
  const [a, b] = c?.chapters ?? [];
  expect(a?.items).toBe(2);
  expect(a?.ref).toBe("job-1:0@2026-10-14T10:00:00.000Z");
  expect(a?.people).toEqual(["Jean Dupont", "Anne-Sophie"]);
  expect(b?.items).toBe(1);
  expect(b?.ref).toBe("job-1:2@2026-10-14T10:05:00.000Z");
});

test("a retired conversation gives no units, its successor's chapters do; removed rows go", () => {
  const s = store();
  apply(
    s,
    pageFixture({
      chapters: [
        chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
        chapter("b", "2026-10-14T10:05:00.000Z", "2026-10-14T10:10:00.000Z"),
      ],
      conversations: [
        conversation("c1"),
        conversation("c0", { retired: { successorId: "c1" } }),
        conversation("s1", { kind: "silent" }),
      ],
      turns: [
        turnFixture(0, "2026-10-14T10:00:00.000Z", null, null),
        turnFixture(1, "2026-10-14T10:06:00.000Z", null, null),
      ],
    })
  );
  expect(readConversations(s, since).map((x) => x.id)).toEqual(["c1"]);
  apply(
    s,
    pageFixture({
      removed: [
        { kind: "chapter", ref: "b" },
        { kind: "turn", ref: "job-1:1" },
      ],
    })
  );
  const [c] = readConversations(s, since);
  expect(c?.chapters.map((h) => h.id)).toEqual(["a"]);
  expect(c?.chapters[0]?.items).toBe(1);
});

test("applying a page twice changes nothing, and an empty store is no conversations", () => {
  const s = store();
  expect(readConversations(s, since)).toEqual([]);
  const p = pageFixture({
    chapters: [
      chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
    ],
    conversations: [conversation("c1")],
    turns: [turnFixture(0, "2026-10-14T10:00:00.000Z", null, null)],
  });
  apply(s, p);
  const once = JSON.stringify(readConversations(s, since));
  expect(apply(s, p)).toBe(true);
  expect(JSON.stringify(readConversations(s, since))).toBe(once);
  expect(apply(s, pageFixture())).toBe(false);
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
  expect(conversationsWith(s, [ANNE]).map((c) => c.id)).toEqual(["c2", "c1"]);
  expect(conversationsWith(s, [ANNE, "nobody"])).toHaveLength(2);
  expect(speakers(s)).toEqual([{ id: ANNE, name: "Anne-Sophie" }]);
});

test("search posts the words and the range with the device token and returns the hits", async () => {
  const server = lifelogServer({
    "/search": () => ({
      hits: [
        {
          capturedFrom: "2026-10-14T10:00:00.000Z",
          conversationId: "c1",
          firstTurn: 1,
          jobId: "job-1",
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
  const server = lifelogServer({
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
  const server = lifelogServer({
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

// The voice server's published contract, kept current by the gate's openapi step.
const CONTRACT = join(import.meta.dir, "../../../voice/openapi.json");

interface Json {
  $ref?: string;
  anyOf?: Json[];
  items?: Json;
  properties?: Record<string, Json>;
  required?: string[];
  type?: string | string[];
}

/** Where Life's schema would refuse what the contract allows: a null it does not take, a field it needs that may be absent. */
function drift(
  life: Json,
  theirs: Json,
  defs: Record<string, Json>,
  at = ""
): string[] {
  const t = theirs.$ref
    ? (defs[theirs.$ref.split("/").at(-1) ?? ""] ?? {})
    : theirs;
  const nullable = (s: Json) =>
    [s.type].flat().includes("null") ||
    !!s.anyOf?.some((x) => x.type === "null");
  const l = life.anyOf?.find((x) => x.type !== "null") ?? life;
  const out =
    nullable(t) && life.type && !nullable(life) ? [`${at}: null`] : [];
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
    ...drift(ours(Hits), answer("/search", "post"), defs, "search"),
    ...drift(ours(Stays), answer("/visits", "get"), defs, "visits"),
    ...drift(ours(Stays), answer("/where", "get"), defs, "where"),
    // Not /status: its contract leaves pendant and phoneHeartbeat untyped, so LifelogStatus takes each field as
    // optional and nullable (tested below) and there is nothing to compare.
  ]).toEqual([]);
});

test("a feed page with a turn not yet in a conversation and a conversation retired with no successor is read", () => {
  const p = Page.parse(
    pageFixture({
      chapters: [
        {
          ...chapter(
            "a",
            "2026-10-14T10:00:00.000Z",
            "2026-10-14T10:05:00.000Z"
          ),
          summary: null,
          title: null,
        },
      ],
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

test("visits: lifelog's 404 (no place the phone named matches) is no stays", async () => {
  // No route: the test server answers 404, as lifelog does when nothing matches.
  const server = lifelogServer({});
  try {
    expect(await visits({ place: "Nowhere" })).toEqual([]);
  } finally {
    server.close();
  }
});

test("a chapter holds the marks whose wake turn is in it, as lifelog has the turn now: re-cut, named or gone", () => {
  const s = store();
  const R0 = "job-1:0@2026-10-14T10:01:00.000Z";
  const R1 = "job-1:1@2026-10-14T10:06:00.000Z";
  const cut = (id: string) =>
    pageFixture({
      chapters: [
        {
          ...chapter(
            "a",
            "2026-10-14T10:00:00.000Z",
            "2026-10-14T10:05:00.000Z"
          ),
          conversationId: id,
        },
        {
          ...chapter(
            "b",
            "2026-10-14T10:05:00.000Z",
            "2026-10-14T10:10:00.000Z"
          ),
          conversationId: id,
        },
      ],
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
      ?.chapters.map((h) => h.marked);
  expect(marked("c1")).toEqual([[R0, "r0b"], [R1]]);
  // Re-cut into c2: the marks follow their turns. Heard again with no mark from 10:05: that one goes.
  apply(s, cut("c2"));
  expect(marked("c2")).toEqual([[R0, "r0b"], [R1]]);
  writeMarks(s, "c2", "2026-10-14T10:05:00.000Z", []);
  expect(marked("c2")).toEqual([[R0, "r0b"], undefined]);
  // Heard again unchanged: nothing to rebuild.
  expect(writeMarks(s, "c2", "", [[R0, "r0b"]])).toBe(false);
  // lifelog transcribed the recording again: another turn at the same index (a new start) is not the wake.
  apply(
    s,
    pageFixture({
      turns: [
        turnFixture(0, "2026-10-14T10:02:00.000Z", null, null, "c2", true),
      ],
    })
  );
  expect(marked("c2")).toEqual([undefined, undefined]);
  apply(
    s,
    pageFixture({
      turns: [
        turnFixture(0, "2026-10-14T10:01:00.000Z", null, null, "c2", true),
      ],
    })
  );
  // lifelog names someone else for the wake turn: no longer his mark.
  apply(
    s,
    pageFixture({
      turns: [
        turnFixture(0, "2026-10-14T10:01:00.000Z", ANNE, "Anne-Sophie", "c2"),
      ],
    })
  );
  expect(marked("c2")).toEqual([undefined, undefined]);
});

test("lifelog's /status is read whatever its untyped objects hold: absent, null, or partly there", () => {
  expect(LifelogStatus.parse({})).toEqual({});
  expect(
    LifelogStatus.parse({ other: 1, pendant: null, phoneHeartbeat: null })
  ).toEqual({
    pendant: null,
    phoneHeartbeat: null,
  });
  expect(
    LifelogStatus.parse({
      pendant: { batteryPercent: 0, connection: null, recording: "recording" },
      phoneHeartbeat: { backlog: null },
    }).pendant?.batteryPercent
  ).toBe(0);
});

test("the newest turn is read without creating or changing the store: no store, no file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "life-newest-turn-"));
  expect(await newestTurn(join(dir, "watch"))).toBeNull();
  expect(existsSync(join(dir, "watch"))).toBe(false);
  rmSync(dir, { force: true, recursive: true });
});
