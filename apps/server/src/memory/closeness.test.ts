import { expect, test } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { type Closeness, Correction } from "../records/observation";
import type { SourceEvent } from "../records/source";
import { apply } from "../sources/lifelog";
import {
  conversation,
  lifelogStore,
  pageFixture,
  turnFixture,
} from "../sources/store-fixtures";
import {
  bucket,
  chatDays,
  closenessTally,
  dueFor,
  levelsNow,
  pagedBy,
  pagedNow,
  parseLevels,
  personallyClose,
  voiceDays,
} from "./closeness";
import { pagePath } from "./ledger";

const msg = (
  chat: string,
  at: string,
  fromMe: boolean,
  sender = chat
): SourceEvent => ({
  at,
  chat,
  fromMe,
  id: `${chat}:${at}`,
  sender: fromMe ? "me" : sender,
  source: "whatsapp",
  text: "…",
});

test("closeness counts 1:1 chats and mail only, by the day each side wrote; a group or a mailing list says nothing", () => {
  const resolve = (s: string) =>
    ({
      "+1": "person:ann",
      "+2": "person:bob",
      "ann@x.com": "person:ann",
      lid1: "person:bob",
    })[s] ?? null;
  const days = chatDays(
    [
      msg("+1", "2026-10-01T10:00:00.000Z", false),
      msg("+1", "2026-10-01T11:00:00.000Z", true),
      msg("+1", "2026-10-02T10:00:00.000Z", false),
      msg("grp", "2026-10-01T10:00:00.000Z", false, "+1"),
      msg("grp", "2026-10-01T10:05:00.000Z", false, "+2"),
      msg("+9", "2026-10-01T10:00:00.000Z", false),
      // A chat only he wrote in counts for its person, one way.
      msg("+2", "2026-10-02T09:00:00.000Z", true),
      // One person writing from two handles in one chat is still a 1:1.
      msg("bob-chat", "2026-10-02T10:00:00.000Z", false, "+2"),
      msg("bob-chat", "2026-10-02T10:01:00.000Z", false, "lid1"),
      // A mail thread both ways: a mail day, not a chat day.
      {
        ...msg("thread", "2026-10-02T11:00:00.000Z", false, "ann@x.com"),
        source: "mail" as const,
      },
      {
        ...msg("thread", "2026-10-02T12:00:00.000Z", true),
        source: "mail" as const,
      },
      // A group by its id, though only one other person wrote in it, and a newsletter.
      msg("120@g.us", "2026-10-01T10:00:00.000Z", false, "+2"),
      { ...msg("+2", "2026-10-01T10:00:00.000Z", false), bulk: true },
    ],
    resolve
  );
  expect([...days.keys()].sort()).toEqual(["person:ann", "person:bob"]);
  const t = closenessTally(days.get("person:ann") ?? new Map(), "2026-10-02");
  expect(t).toMatchObject({
    first: "2026-10-01",
    last: "2026-10-02",
    mail: 1,
    twoWay: 1,
    voice: 0,
  });
  expect(
    closenessTally(days.get("person:bob") ?? new Map(), "2026-10-02").recent
  ).toBeGreaterThan(0.3);
  // A day both ways weighs 1, one way 0.3, the more of chat and mail (day 2: one way in chat, both ways in mail).
  expect(t.recent).toBe(2);
  expect(bucket(t)).toBe("2/2");
});

const row = (person: string, over: Partial<Closeness> = {}): Closeness =>
  ({
    at: "2026-10-20T00:00:00.000Z",
    counts: "0/0",
    madeBy: {} as never,
    person,
    personal: "acquaintance",
    schemaVersion: 1,
    service: false,
    why: "…",
    work: "acquaintance",
    ...over,
  }) as Closeness;

test("a level keeps a page when close or once close, never a service's; his word wins; a folded person is the kept one", () => {
  const rows = new Map([
    ["person:ann", row("person:ann", { personal: "inner" })],
    ["person:bob", row("person:bob", { work: "regular" })],
    ["person:old", row("person:old", { personal: "faded" })],
    ["person:bank", row("person:bank", { personal: "regular", service: true })],
    ["person:joe", row("person:joe", { personal: "inner" })],
    // Folded into Ann: only Ann's own judgment counts.
    ["person:ann2", row("person:ann2", { at: "2026-10-21T00:00:00.000Z" })],
  ]);
  const levels = levelsNow(rows, [
    {
      at: "2026-10-20T00:00:00.000Z",
      kind: "closeness",
      person: "person:joe",
      personal: "acquaintance",
    } as never,
    {
      at: "2026-10-20T00:00:00.000Z",
      from: "person:ann2",
      kind: "same-person",
      to: "person:ann",
    } as never,
  ]);
  expect(levels.get("person:joe")).toMatchObject({
    personal: "acquaintance",
    why: "your word",
  });
  expect(levels.has("person:ann2")).toBe(false);
  expect(levels.get("person:ann")?.personal).toBe("inner");
  // Someone waiting keeps a page until judged; a judgment beats waiting (joe).
  expect([...pagedBy(levels, ["person:new", "person:joe"])].sort()).toEqual([
    "person:ann",
    "person:bob",
    "person:me",
    "person:new",
    "person:old",
  ]);
  // Close personally, now or once: Between us. Not work, not a service, not one he lowered.
  expect([...personallyClose(levels)].sort()).toEqual([
    "person:ann",
    "person:old",
  ]);
});

test("the judgment is checked: a person not asked about, twice, or a level out of the list is refused", () => {
  const asked = new Map([["person:ann", "1/2"]]);
  const { invalid, rows } = parseLevels(
    {
      people: [
        {
          person: "person:ann",
          personal: "inner",
          why: "partner",
          work: "acquaintance",
        },
        {
          person: "person:ann",
          personal: "regular",
          why: "again",
          work: "acquaintance",
        },
        { person: "person:zed", personal: "inner", why: "?", work: "inner" },
        { person: "person:ann", personal: "best", why: "?", work: "inner" },
      ],
    },
    asked,
    {
      at: "2026-10-20T00:00:00.000Z",
      madeBy: {
        engine: "claude",
        model: "m",
        prompt: "closeness.v1",
        run: "r",
      } as never,
    }
  );
  expect(invalid).toBe(3);
  expect(rows.map((r) => [r.person, r.personal, r.counts])).toEqual([
    ["person:ann", "inner", "1/2"],
  ]);
});

test("voice days are the days someone spoke in a live recording, by lifelog's own speakers", () => {
  const store = lifelogStore();
  apply(
    store,
    pageFixture({
      conversations: [conversation("c1")],
      turns: [
        turnFixture(0, "2026-10-14T10:01:00.000Z", "p1", "Anne-Sophie"),
        turnFixture(1, "2026-10-14T10:02:00.000Z", null, null),
      ],
    })
  );
  const days = voiceDays(store, (s) => (s === "p1" ? "person:anne" : null));
  expect([...days.keys()]).toEqual(["person:anne"]);
  expect([...(days.get("person:anne")?.values() ?? [])]).toEqual([
    { chat: { got: 0, sent: 0 }, mail: { got: 0, sent: 0 }, voice: true },
  ]);
});

test("judged again only when the rounded counts moved or the prompt changed; everyone on his map, the rest from some lasting", () => {
  const t = (lasting: number) => ({
    ...closenessTally(new Map(), "2026-10-20"),
    lasting,
  });
  const judged = new Map([
    [
      "person:ann",
      row("person:ann", {
        counts: bucket(t(3)),
        madeBy: { prompt: "closeness.v1" } as never,
      }),
    ],
    [
      "person:bob",
      row("person:bob", {
        counts: bucket(t(3)),
        madeBy: { prompt: "closeness.v0" } as never,
      }),
    ],
  ]);
  const due = dueFor(
    [
      { ref: "person:ann", t: t(3) },
      { ref: "person:bob", t: t(3) },
      { ref: "person:cid", t: t(0.2) },
      { ref: "person:dad", t: t(0) },
      { ref: "person:eli", t: t(2) },
      { ref: "person:me", t: t(9) },
    ],
    judged,
    new Set(["person:dad"])
  ).map((d) => d.ref);
  expect(due).toEqual(["person:bob", "person:dad", "person:eli"]);
  // A written page waits: judged with nothing counted.
  expect(
    dueFor(
      [{ ref: "person:inf_x", t: t(0) }],
      new Map(),
      new Set(["person:inf_x"])
    )
  ).toHaveLength(1);
  // Nothing counted: no first or last day, not today.
  expect(closenessTally(new Map(), "2026-10-20")).toMatchObject({
    first: null,
    last: null,
  });
});

test("a WhatsApp or iMessage chat that isn't a group by its id is 1:1, a handle Life can't place included; on a bridged network two senders are a group", () => {
  const resolve = (s: string) => (s === "+3" ? "person:cat" : null);
  const at = "2026-10-01T10:00:00.000Z";
  const days = chatDays(
    [
      msg("+3", at, false, "+3"),
      msg("+3", at, false, "lid-unplaced"),
      { ...msg("!room", at, false, "+3"), source: "line" as const },
      { ...msg("!room", at, false, "someone"), source: "line" as const },
    ],
    resolve
  );
  expect([...days.keys()]).toEqual(["person:cat"]);
  expect([...(days.get("person:cat")?.values() ?? [])][0]?.chat.got).toBe(2);
});

test("a closeness correction names a personal or a work level", () => {
  const base = {
    at: "2026-10-20T00:00:00.000Z",
    kind: "closeness",
    person: "person:ann",
    schemaVersion: 1,
  };
  expect(Correction.safeParse({ ...base, personal: "inner" }).success).toBe(
    true
  );
  expect(Correction.safeParse(base).success).toBe(false);
});

test("a written page stays until its person is judged: no closeness ledger deletes no page", async () => {
  const path = pagePath("person:inf_new");
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, "# New\n");
  try {
    expect(await pagedNow({ people: [] })).toContain("person:inf_new");
  } finally {
    await rm(path);
  }
});
