import { expect, spyOn, test } from "bun:test";
import type { Episode } from "../records/episode";
import type { MatterBatch } from "../records/matter";
import {
  callsOf,
  type MatterWork,
  matterLines,
  matters,
  mattersNow,
  pendingOf,
  readMatters,
  readMatterWork,
  type ShownEpisode,
  shownEpisodesOf,
} from "./matters";
import type { People } from "./who";

const people = {
  truth: {
    areas: [{ id: "family", name: "Family" }],
    me: { text: "A shop owner." },
    projects: [{ id: "shop-fit-out", name: "Shop fit-out" }],
  },
} as unknown as People;

const fact = (n: number, type: string, text: string) => ({
  id: `obs_${String(n).padStart(12, "0")}`,
  text,
  type,
});
const pad = (n: number) => String(n).padStart(12, "0");
const episode = (
  day: string,
  title: string,
  what: string,
  unit: number,
  facts: ShownEpisode["facts"] = []
): ShownEpisode => ({
  day,
  facts,
  id: `ep_${pad(unit)}`,
  people: [{ name: "Gran", role: "with" }],
  title,
  units: [`unit_${pad(unit)}`],
  what,
});
const [f1, f2, f3, f4, f5, f6] = [
  fact(1, "to_do", "Get Gran's watch repaired"),
  fact(2, "event", "Gran says the strap broke last week"),
  fact(3, "event", "His partner suggests the shop on Elm Street"),
  fact(4, "event", "The shopkeeper says the repair takes ten days"),
  fact(5, "promise", "He will call the shop on Monday"),
  fact(6, "event", "Birthday dinner on Saturday"),
];
const week1 = [
  episode(
    "2026-10-02",
    "Gran's watch",
    "Gran asks for her watch to be mended.",
    1,
    [f1, f2]
  ),
  episode("2026-10-03", "Chat with partner", "They pick a shop.", 2, [f3]),
  episode("2026-10-04", "Dinner plans", "A birthday dinner.", 6, [f6]),
];
const week2 = [
  episode("2026-10-09", "Shop mail", "The shopkeeper answers.", 3, [f4]),
  episode("2026-10-12", "Promise", "A promise to call.", 4, [f5]),
];
const week3 = [
  episode(
    "2026-10-16",
    "Call to the shop",
    "He and his partner phone the shopkeeper, in French, about Gran's watch.",
    5
  ),
];
const unitId = (n: number) => `unit_${pad(n)}`;
const unit1 = unitId(1);
const unit2 = unitId(2);
const unit5 = unitId(5);
const unit6 = unitId(6);
const MINTED = /^matter_[0-9a-f]{12}$/;
const span = (from: string, to: string) => ({ from, to });

/** A span's work as the step reads it: what was offered already is left out. */
const workOf = (
  episodes: ShownEpisode[],
  from: string,
  to: string,
  reminders: MatterWork["reminders"] = []
): MatterWork => ({
  ...pendingOf(episodes, reminders, mattersNow(readMatters()).offered),
  span: span(from, to),
});

test("an errand over three spans lands in one matter, the call's episode with no fact included", async () => {
  const models = await import("../models/llm");
  let minted = "";
  const replies = [
    // Span 1: a new matter; one member whose words are not in its record, one ref never shown, an area and a project not on his map.
    () => ({
      matters: [
        {
          area: "nowhere",
          id: "new-1",
          members: [
            { quote: "get Gran's watch repaired", ref: f1.id },
            { quote: "strap broke last week", ref: f2.id },
            { quote: "the clock tower", ref: `ep_${pad(1)}` },
            { quote: "a shop", ref: "obs_ffffffffffff" },
            { quote: "shop on Elm Street", ref: f3.id },
          ],
          name: "Mend Gran's watch",
          projects: ["ghost", "shop-fit-out"],
        },
      ],
    }),
    (input: { open: { id: string }[] }) => {
      minted = input.open[0]?.id ?? "";
      return {
        matters: [
          {
            area: "family",
            id: minted,
            members: [
              { quote: "repair takes ten days", ref: f4.id },
              { quote: "call the shop on Monday", ref: f5.id },
            ],
            name: "Mend Gran's watch",
            projects: [],
          },
        ],
      };
    },
    (input: { open: { id: string; latest: { day: string } }[] }) => {
      // The third span sees the matter and the day of its newest member.
      expect(input.open.map((m) => [m.id, m.latest.day])).toEqual([
        [minted, "2026-10-12"],
      ]);
      return {
        matters: [
          {
            area: "family",
            id: minted,
            // The call is placed as its episode, and stored as the episode's unit.
            members: [{ quote: "phone the shopkeeper", ref: `ep_${pad(5)}` }],
            name: "Mend Gran's watch for Gran",
          },
        ],
      };
    },
  ];
  const ask = spyOn(models, "askOnce").mockImplementation(((o: {
    input: never;
  }) => Promise.resolve(replies.shift()?.(o.input))) as never);
  try {
    await matters(workOf(week1, "2026-10-01", "2026-10-07"), people);
    const first = mattersNow(readMatters());
    expect(first.matters).toHaveLength(1);
    const [m1] = first.matters;
    // The id is minted by code; what is not on his map, not shown or not found in its record is dropped.
    expect(m1?.id).toMatch(MINTED);
    expect(m1?.area).toBeNull();
    expect(m1?.projects).toEqual(["shop-fit-out"]);
    expect(m1?.members.map((m) => m.ref)).toEqual([f1.id, f2.id, f3.id]);
    // Everything offered is known as asked, the unplaced dinner and the dropped unit included.
    expect([...first.offered].sort()).toEqual(
      [f1.id, f2.id, f3.id, f6.id, unit1, unit2, unit6].sort()
    );

    await matters(workOf(week2, "2026-10-08", "2026-10-14"), people);
    await matters(workOf(week3, "2026-10-15", "2026-10-21"), people);
    expect(ask).toHaveBeenCalledTimes(3);
    const [matter, ...rest] = mattersNow(readMatters()).matters;
    expect(rest).toEqual([]);
    expect(matter?.id).toBe(minted);
    expect(matter?.name).toBe("Mend Gran's watch for Gran");
    expect(matter?.area).toBe("family");
    expect(matter?.members.map((m) => m.ref)).toEqual([
      f1.id,
      f2.id,
      f3.id,
      f4.id,
      f5.id,
      unit5,
    ]);
    expect(matterLines()).toEqual([
      "Mend Gran's watch for Gran · area family · projects none · 6 members · newest 2026-10-16",
    ]);

    // A second run over the same spans asks nothing: the ones placed nowhere were asked once.
    const again = [
      workOf(week1, "2026-10-01", "2026-10-07"),
      workOf(week2, "2026-10-08", "2026-10-14"),
      workOf(week3, "2026-10-15", "2026-10-21"),
    ];
    expect(again.map((w) => callsOf(w))).toEqual([[], [], []]);
    await matters(again[0] as MatterWork, people);
    expect(ask).toHaveBeenCalledTimes(3);
  } finally {
    ask.mockRestore();
  }
});

test("a source that failed gives no work: a span is never placed from half a read", async () => {
  expect(
    await readMatterWork(span("2026-10-01", "2026-10-07"), people, ["mail"])
  ).toBeNull();
});

test("a matter is its latest name and the union of its members, a later placement of a record winning", () => {
  const line = (
    at: string,
    id: string,
    name: string,
    refs: [string, string][],
    offered: string[] = []
  ): MatterBatch => ({
    at,
    madeBy: { engine: "claude", model: "m", prompt: "p", run: "r" },
    matters: [
      {
        area: null,
        id,
        members: refs.map(([ref, day]) => ({ day, quote: "q", ref })),
        name,
        projects: [],
      },
    ],
    offered,
    schemaVersion: 1,
  });
  const a = "matter_aaaaaaaaaaaa";
  const b = "matter_bbbbbbbbbbbb";
  const now = mattersNow([
    line(
      "2026-10-05T10:00:00.000Z",
      a,
      "Old name",
      [
        ["r1", "2026-10-01"],
        ["r2", "2026-10-02"],
      ],
      ["r1", "r2", "r3"]
    ),
    line("2026-10-12T10:00:00.000Z", a, "New name", [["r4", "2026-10-11"]]),
    line("2026-10-13T10:00:00.000Z", b, "Other", [["r2", "2026-10-02"]]),
  ]);
  expect(
    now.matters.map((m) => [m.id, m.name, m.members.map((x) => x.ref)])
  ).toEqual([
    [a, "New name", ["r1", "r4"]],
    [b, "Other", ["r2"]],
  ]);
  expect([...now.offered].sort()).toEqual(["r1", "r2", "r3"]);
});

test("the errand's small steps are shown: a fact rated 1, and a mail no episode holds as an episode of its own", () => {
  const ep = (
    id: number,
    day: string,
    units: string[],
    copies: string[] = []
  ) =>
    ({
      copies,
      day,
      end: null,
      id: `ep_${pad(id)}`,
      people: [],
      start: null,
      title: `Episode ${id}`,
      units,
      what: "",
    }) as unknown as Episode;
  const factNow = (
    n: number,
    unit: number,
    date: string,
    importance: number
  ) => ({
    date,
    id: `obs_${pad(n)}`,
    importance,
    text: `fact ${n}`,
    type: "news",
    unit: unitId(unit),
  });
  const shown = shownEpisodesOf(
    span("2026-10-08", "2026-10-14"),
    [
      ep(1, "2026-10-09", [unitId(1), unitId(2)], [unitId(2)]),
      ep(2, "2026-10-20", [unitId(3)]),
    ],
    [
      factNow(1, 1, "2026-10-09", 1), // the address, rated 1: shown
      factNow(2, 1, "2026-10-09", 0), // rated 0: not shown
      factNow(3, 9, "2026-10-11", 1), // the photos by mail, in no episode: an episode of its own
      factNow(4, 8, "2026-10-30", 2), // in no episode, outside the span
    ],
    (u) => `title of ${u}`,
    { nameOf: (r) => r, refOf: (r) => r }
  );
  expect(
    shown.map((e) => [e.id, e.title, e.units, e.facts.map((f) => f.id)])
  ).toEqual([
    [`ep_${pad(1)}`, "Episode 1", [unitId(1)], [`obs_${pad(1)}`]],
    [unitId(9), `title of ${unitId(9)}`, [unitId(9)], [`obs_${pad(3)}`]],
  ]);
});
