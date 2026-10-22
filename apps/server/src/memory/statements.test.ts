import { expect, test } from "bun:test";
import type { Moment } from "../records/moments";
import type { Statement } from "../records/statements";
import { momentGroup, momentText, spread } from "./statements";

const draft = (
  claim: string,
  group: string,
  kind: Statement["kind"] = "fact"
) => ({
  claim,
  date: "2026-10-01",
  group,
  kind,
  source: "whatsapp" as const,
  text: claim,
  units: ["u_000000000000"],
});
/** This year: dates in it are said without the year. */
const YEAR = new Date().getFullYear();
const ids = (n: number) =>
  Array.from(
    { length: n },
    (_, i) => `obs_${i.toString(16).padStart(12, "0")}`
  );

test("a draw takes one of each group first, then a second of each, never more than asked, the same every time", () => {
  const pool = [
    ...ids(100).map((id) => draft(id, "area:shop")),
    ...ids(4).map((id) => draft(id.replace("obs_0", "obs_1"), "person:dad")),
  ];
  const drawn = spread(pool, 24);
  const count = (g: string) => drawn.filter((d) => d.group === g).length;
  expect(drawn).toHaveLength(24);
  expect(count("area:shop")).toBe(20);
  expect(count("person:dad")).toBe(4);
  expect(spread(pool.toReversed(), 24)).toEqual(drawn);
  expect(spread(pool.slice(0, 3), 10)).toHaveLength(3);
});

test("a small draw takes one of each group first, however many kinds and months a big group has", () => {
  const big = (["fact", "plan", "reported"] as const).flatMap((kind, k) =>
    ["2026-07-01", "2026-08-01", "2026-09-01"].map((date, m) => ({
      ...draft(`obs_a${k}${m}000000000`, "area:shop", kind),
      date,
    }))
  );
  const small = ["b", "c", "d", "e", "f"].map((g) =>
    draft(`obs_${g}00000000000`, `person:${g}`)
  );
  const drawn = spread([...big, ...small], 6);
  expect(new Set(drawn.map((d) => d.group)).size).toBe(6);
});

test("within a group the draw goes round its kinds, then a kind's channels, however many channels and months one kind has", () => {
  const facts = (["whatsapp", "imessage", "mail"] as const).flatMap(
    (source, s) =>
      ["2026-07-01", "2026-08-01", "2026-09-01"].map((date, m) => ({
        ...draft(`obs_a${s}${m}000000000`, "area:shop"),
        date,
        source,
      }))
  );
  const plans = ids(3).map((id) =>
    draft(id.replace("obs_0", "obs_1"), "area:shop", "plan")
  );
  const drawn = spread([...facts, ...plans], 6);
  expect(drawn.filter((d) => d.kind === "plan")).toHaveLength(3);
  expect(
    new Set(drawn.filter((d) => d.kind === "fact").map((d) => d.source)).size
  ).toBe(3);
});

test("a moment is said as its status, time (a same-day end as a time only), place and the people it was with", () => {
  const m = {
    end: `${YEAR}-09-07 22:30`,
    people: [
      { ref: "person:zoe", role: "with" },
      { ref: "unknown:Bob", role: "with" },
      { ref: "person:dad", role: "told" },
    ],
    place: "Chez Paul",
    start: `${YEAR}-09-07 20:00`,
    status: "happened",
    title: "Dinner",
  } as Moment;
  const names = new Map([["person:zoe", "Zoé"]]);
  const name = (ref: string) => names.get(ref) ?? ref.split(":")[1] ?? ref;
  expect(momentText(m, name)).toBe(
    "Happened: Dinner, 7 Sep 20:00–22:30, at Chez Paul; with Zoé, Bob; told dad."
  );
  expect(
    momentText(
      {
        ...m,
        end: `${YEAR}-09-08`,
        people: [],
        place: null,
        status: "planned",
      },
      name
    )
  ).toBe("Planned: Dinner, 7 Sep 20:00–8 Sep.");
});

test("a moment is rated with the one person with a page it was with, as who.ts says today; else under events; never unsure", () => {
  const m = (people: [string, string][], status = "happened") =>
    ({
      people: people.map(([ref, role]) => ({ ref, role })),
      status,
    }) as Moment;
  const paged = new Set(["person:zoe", "person:dad"]);
  const refOf = (r: string) => (r === "unknown:Zoé" ? "person:zoe" : r);
  expect(
    momentGroup(
      m([
        ["unknown:Zoé", "with"],
        ["person:dad", "told"],
      ]),
      paged,
      refOf
    )
  ).toBe("person:zoe");
  expect(
    momentGroup(
      m([
        ["person:zoe", "with"],
        ["person:dad", "with"],
      ]),
      paged,
      refOf
    )
  ).toBe("events");
  expect(momentGroup(m([["person:bob", "with"]]), paged, refOf)).toBe("events");
  expect(
    momentGroup(m([["person:zoe", "with"]], "unsure"), paged, refOf)
  ).toBeNull();
});
