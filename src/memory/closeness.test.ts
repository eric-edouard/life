import { expect, test } from "bun:test";
import type { Closeness, SourceEvent } from "../schema";
import {
  chapter,
  conversation,
  lifelogStore,
  page,
  turn,
} from "../sources/fixtures";
import { apply } from "../sources/lifelog";
import {
  bucket,
  chatDays,
  dueFor,
  levelsNow,
  pagedBy,
  parseLevels,
  tally,
  voiceDays,
} from "./closeness";

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
    ({ "+1": "person:ann", "+2": "person:bob" })[s] ?? null;
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
      // A group by its id, though only one other person wrote in it, and a newsletter.
      msg("120@g.us", "2026-10-01T10:00:00.000Z", false, "+2"),
      { ...msg("+2", "2026-10-01T10:00:00.000Z", false), bulk: true },
    ],
    resolve
  );
  expect([...days.keys()].sort()).toEqual(["person:ann", "person:bob"]);
  const t = tally(days.get("person:ann") ?? new Map(), "2026-10-02");
  expect(t).toMatchObject({
    first: "2026-10-01",
    last: "2026-10-02",
    twoWay: 1,
    voice: 0,
  });
  // A day both ways weighs 1, one way 0.3, halving with age.
  expect(t.recent).toBe(1.3);
  expect(bucket(t)).toBe("1/1");
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

test("a level keeps a page when close or once close, never a service's; family stays regular; his word wins", () => {
  const rows = new Map([
    ["person:ann", row("person:ann", { personal: "inner" })],
    ["person:bob", row("person:bob", { work: "regular" })],
    ["person:dad", row("person:dad")],
    ["person:old", row("person:old", { personal: "faded" })],
    ["person:bank", row("person:bank", { personal: "regular", service: true })],
    ["person:joe", row("person:joe", { personal: "inner" })],
    ["person:eve", row("person:eve")],
    ["person:tom", row("person:tom")],
    ["person:liz", row("person:liz")],
    // Folded into Ann: her levels are Ann's.
    [
      "person:ann2",
      row("person:ann2", {
        at: "2026-10-19T00:00:00.000Z",
        personal: "regular",
      }),
    ],
  ]);
  const truth = {
    people: [
      { id: "dad", relation: "father" },
      { id: "new", relation: "friend" },
      { id: "bob", relation: "business partner" },
      { id: "eve", relation: "ex-girlfriend" },
      { id: "tom", relation: "brother, runs a business" },
      { id: "liz", relation: "sister-in-law" },
    ],
  } as never;
  const levels = levelsNow(
    rows,
    [
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
    ],
    truth
  );
  expect(levels.get("person:dad")?.personal).toBe("regular");
  // A business partner, an ex: not family.
  expect(levels.get("person:bob")?.personal).toBe("acquaintance");
  expect(levels.get("person:eve")?.personal).toBe("acquaintance");
  // What follows the family word doesn't undo it; an in-law isn't kept.
  expect(levels.get("person:tom")?.personal).toBe("regular");
  expect(levels.get("person:liz")?.personal).toBe("acquaintance");
  expect(levels.get("person:joe")?.why).toBe("your word");
  expect(levels.has("person:ann2")).toBe(false);
  expect(levels.get("person:ann")?.personal).toBe("inner");
  expect(levels.get("person:joe")?.personal).toBe("acquaintance");
  expect([...pagedBy(levels, truth)].sort()).toEqual([
    "person:ann",
    "person:bob",
    "person:dad",
    "person:me",
    "person:new",
    "person:old",
    "person:tom",
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
    page({
      chapters: [
        chapter("a", "2026-10-14T10:00:00.000Z", "2026-10-14T10:05:00.000Z"),
      ],
      conversations: [conversation("c1")],
      turns: [
        turn(0, "2026-10-14T10:01:00.000Z", "p1", "Anne-Sophie"),
        turn(1, "2026-10-14T10:02:00.000Z", null, null),
      ],
    })
  );
  const days = voiceDays(store, (s) => (s === "p1" ? "person:anne" : null));
  expect([...days.keys()]).toEqual(["person:anne"]);
  expect([...(days.get("person:anne")?.values() ?? [])]).toEqual([
    { got: 0, sent: 0, voice: true },
  ]);
});

test("judged again only when the rounded counts moved or the prompt changed; everyone on his map, the rest from some lasting", () => {
  const t = (lasting: number) => ({
    ...tally(new Map(), "2026-10-20"),
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
  // Nothing counted: no first or last day, not today.
  expect(tally(new Map(), "2026-10-20")).toMatchObject({
    first: null,
    last: null,
  });
});
