import { expect, test } from "bun:test";
import type { Closeness, SourceEvent } from "../schema";
import {
  bucket,
  chatDays,
  levelsNow,
  pagedBy,
  parseLevels,
  tally,
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

test("closeness counts 1:1 chats only, by the day each side wrote; a group says nothing of closeness", () => {
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
    ],
    resolve
  );
  expect([...days.keys()]).toEqual(["person:ann"]);
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
  ]);
  const truth = {
    people: [
      { id: "dad", relation: "father" },
      { id: "new", relation: "friend" },
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
    ],
    truth
  );
  expect(levels.get("person:dad")?.personal).toBe("regular");
  expect(levels.get("person:joe")?.personal).toBe("acquaintance");
  expect([...pagedBy(levels, truth)].sort()).toEqual([
    "person:ann",
    "person:bob",
    "person:dad",
    "person:me",
    "person:new",
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
