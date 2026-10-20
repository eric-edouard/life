import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { CLOSED_ON_SILENCE_S } from "../hear";
import {
  chapter,
  conversation,
  lifelogServer,
  page,
  lifelogStore as store,
  turn,
} from "./fixtures";
import {
  apply,
  conversationsWith,
  Hits,
  Page,
  poll,
  readConversations,
  Stays,
  searchVoice,
  speakers,
  Transcript,
  turnOffset,
  turnsBetween,
  visits,
} from "./lifelog";

const since = new Date("2026-10-01T00:00:00Z");
const JEAN = "person-jean";
const ANNE = "person-anne";

test("a name given to one turn names that turn, not the whole voice", () => {
  const s = store();
  // Voice speaker_0 is unnamed; the owner named only turn 1. The server sends each turn with the name that wins for it.
  apply(
    s,
    page({
      chapters: [
        chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
        chapter("b", "2026-10-14T10:05:00.000Z", "2026-10-14T10:10:00.000Z"),
      ],
      conversations: [conversation("c1")],
      turns: [
        turn(0, "2026-10-14T10:00:00.000Z", null, null),
        turn(1, "2026-10-14T10:01:00.000Z", ANNE, "Anne-Sophie"),
        turn(2, "2026-10-14T10:02:00.000Z", null, null),
        turn(3, "2026-10-14T10:06:00.000Z", null, null),
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

test("a chapter holds its turns, its first turn's ref, and names the map gives its people", () => {
  const s = store();
  apply(
    s,
    page({
      chapters: [
        chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
        chapter("b", "2026-10-14T10:05:00.000Z", "2026-10-14T10:10:00.000Z"),
      ],
      conversations: [conversation("c1", { ownerTitle: "Plumber visit" })],
      turns: [
        turn(0, "2026-10-14T10:00:00.000Z", JEAN, "Jean (Me)"),
        turn(1, "2026-10-14T10:04:00.000Z", ANNE, "Anne-Sophie"),
        turn(2, "2026-10-14T10:05:00.000Z", ANNE, "Anne-Sophie"),
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
    page({
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
        turn(0, "2026-10-14T10:00:00.000Z", null, null),
        turn(1, "2026-10-14T10:06:00.000Z", null, null),
      ],
    })
  );
  expect(readConversations(s, since).map((x) => x.id)).toEqual(["c1"]);
  apply(
    s,
    page({
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

test("applying a page twice changes nothing, and an empty store is an error", () => {
  const s = store();
  expect(() => readConversations(s, since)).toThrow("empty");
  const p = page({
    chapters: [
      chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
    ],
    conversations: [conversation("c1")],
    turns: [turn(0, "2026-10-14T10:00:00.000Z", null, null)],
  });
  apply(s, p);
  const once = JSON.stringify(readConversations(s, since));
  expect(apply(s, p)).toBe(true);
  expect(JSON.stringify(readConversations(s, since))).toBe(once);
  expect(apply(s, page())).toBe(false);
});

test("a turn's place in its conversation, and a person's conversations newest first", () => {
  const s = store();
  apply(
    s,
    page({
      conversations: [
        conversation("c1"),
        conversation("c2", { startAt: "2026-10-15T09:00:00.000Z" }),
        conversation("c3", { kind: "silent" }),
      ],
      turns: [
        turn(0, "2026-10-14T10:00:00.000Z", null, null),
        turn(1, "2026-10-14T10:01:00.000Z", ANNE, "Anne-Sophie"),
        turn(2, "2026-10-14T10:02:00.000Z", ANNE, "Anne-Sophie"),
        turn(0, "2026-10-15T09:00:00.000Z", ANNE, "Anne-Sophie", "c2"),
        turn(0, "2026-10-15T09:00:00.000Z", ANNE, "Anne-Sophie", "c3"),
      ].map((t) => ({ ...t, jobId: `job-${t.conversationId?.slice(1)}` })),
    })
  );
  expect(turnOffset(s, "c1", "job-1", 0)).toBe(0);
  expect(turnOffset(s, "c1", "job-1", 2)).toBe(2);
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
    const hits = await searchVoice("vitre", {
      from: "2026-10-14T00:00:00.000Z",
    });
    expect(hits.map((h) => h.text)).toEqual(["Anne-Sophie: la vitre"]);
    expect(server.seen).toEqual([
      {
        auth: "Bearer test-token",
        body: {
          dateRange: { from: "2026-10-14T00:00:00.000Z" },
          limit: 20,
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
  const anne = turn(1, "2026-10-14T10:01:00.000Z", ANNE, "Anne-Sophie");
  let first = turn(0, "2026-10-14T10:00:00.000Z", ANNE, "Anne-Sophie", "c1");
  const server = lifelogServer({
    "/changes": () =>
      page({ conversations: [conversation("c1")], turns: [first, anne] }),
  });
  try {
    expect((await poll(s, 0)).owner).toEqual([]);
    first = turn(0, "2026-10-14T10:00:00.000Z", JEAN, "Jean (Me)", "c1", true);
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
    ...turn(0, "2026-10-14T10:00:00.000Z", null, null),
    endAt: "2026-10-14T10:00:04.000Z",
  };
  apply(s, Page.parse(page({ turns: [words] })), "2026-10-14T10:01:00.000Z");
  const named = {
    ...words,
    speaker: { isOwner: true, personId: JEAN, personName: "Jean (Me)" },
  };
  apply(s, Page.parse(page({ turns: [named] })), "2026-10-14T10:01:01.000Z");
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
  const lost = turn(0, "2026-10-14T10:00:00.000Z", null, null, "c1");
  const server = lifelogServer({
    "/changes": () =>
      page({ conversations: [conversation("c1")], turns: [lost] }),
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

const CUTTER = join(homedir(), "Work/lifelog/apps/server/src/cutter.ts");

test.skipIf(!existsSync(CUTTER))(
  "lifelog still closes a recording of less speech than CLOSED_ON_SILENCE_S only on 30 s of silence (hear.ts reads it so)",
  () => {
    const ms = (name: string) =>
      Number(
        readFileSync(CUTTER, "utf8")
          .match(new RegExp(`const ${name} = ([\\d_]+)`))?.[1]
          ?.replaceAll("_", "")
      );
    expect(ms("LONG_MS")).toBe(CLOSED_ON_SILENCE_S * 1000);
    expect(ms("CLOCK_MS")).toBe(30_000);
  }
);

// lifelog's published contract, kept current by its own gate. On a Mac without the checkout there is nothing to check.
const CONTRACT = join(homedir(), "Work/lifelog/apps/server/openapi.json");

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

test.skipIf(!existsSync(CONTRACT))(
  "Life reads lifelog's API with the contract's nullability: a field lifelog may send null or leave out never stops the watcher",
  async () => {
    const api = await Bun.file(CONTRACT).json();
    const answer = (path: string, method: string) =>
      api.paths[path][method].responses["200"].content["application/json"]
        .schema;
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
    ]).toEqual([]);
  }
);

test("a feed page with a turn not yet in a conversation and a conversation retired with no successor is read", () => {
  const p = Page.parse(
    page({
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
      turns: [turn(0, "2026-10-14T10:00:00.000Z", null, null, null)],
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
