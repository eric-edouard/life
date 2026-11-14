import { expect, test } from "bun:test";
import { openById } from "./open-by-id";
import {
  nextReads,
  PART_CHARS,
  parseReadPartRef,
  type ReadPartRef,
  readPartRefOf,
} from "./read-part";
import { partLines } from "./read-person-page";

const refs: ReadPartRef[] = [
  { part: "now", subject: "person:ana" },
  { part: "evidence", subject: "person:ana" },
  { part: "evidence", span: "2024-03", subject: "person:ana" },
  {
    before: "2024-03-15",
    part: "evidence",
    span: "2024",
    subject: "person:inf_bo-2",
  },
  { before: "2024-03-15", part: "evidence", subject: "project:house" },
];

test("a read part ref round-trips, and a malformed one says why", () => {
  for (const r of refs) {
    expect(parseReadPartRef(readPartRefOf(r))).toEqual({
      ref: { before: undefined, span: undefined, ...r },
    });
  }
  expect(readPartRefOf(refs[3] as ReadPartRef)).toBe(
    "person:inf_bo-2/evidence/2024/before/2024-03-15"
  );
  for (const bad of [
    "person:Ana/evidence",
    "person:ana",
    "person:ana/year/2024",
    "person:ana/now/2024",
    "person:ana/evidence/March",
    "person:ana/evidence/2024-03/2024-04",
    "person:ana/evidence/before/tomorrow",
  ]) {
    expect(parseReadPartRef(bad)).toHaveProperty("error");
  }
});

test("fetch by id: a subject's id is a part read (a malformed one is an error, never nothing found), and a part takes no fromTurn nor limit", async () => {
  expect(await openById("person:ana/oops")).toContain('no part "oops"');
  expect(await openById("person:ana/evidence", 3)).toContain("no fromTurn");
  expect(await openById("person:ana/evidence", undefined, 5)).toContain(
    "no limit"
  );
  expect(await openById("area:home/now")).toContain(
    "no read parts for area:home"
  );
  expect(await openById("person:ana/evidence")).not.toContain("nothing found");
});

const BEFORE = /before\/(\S+):/;
const day = (n: number) => `2024-03-${String(n).padStart(2, "0")}`;
const items = (kind: "observation" | "episode", days: number[], pad = 0) =>
  days.map((d) => ({
    day: day(d),
    kind,
    line: `- ${kind} ${day(d)}${"x".repeat(pad)}`,
  }));
const base = {
  candidates: [],
  earlier: [],
  heard: [],
  now: (obs: string[]) => ["NOW", ...obs],
  ref: "person:ana",
};

test("evidence: sized by characters, a day never cut, and it ends with the ref of the older read", () => {
  // Two observations and an episode on each of 20 days, about 1,500 characters a day.
  const timeline = [
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
  ].flatMap((d) => [
    ...items("observation", [d, d], 700),
    ...items("episode", [d], 100),
  ]);
  const out = partLines({ ...base, part: "evidence", timeline });
  const size = out.join("\n").length;
  expect(size).toBeLessThan(PART_CHARS + 1500);
  // The newest day is whole: both its observations and its episode.
  expect(out.filter((l) => l.includes(` ${day(20)}`)).length).toBe(3);
  const next = out.at(-1) as string;
  const before = BEFORE.exec(next)?.[1] as string;
  expect(next).toContain(`- person:ana/evidence/before/${before}:`);
  // The day the next read pages from is the last one taken, and its lines are all in this part.
  expect(out.filter((l) => l.includes(` ${before}`)).length).toBe(3);
  expect(
    out.some((l) => l.includes(` ${day(Number(before.slice(-2)) - 1)}`))
  ).toBe(false);
});

test("evidence of one span: only its days, and nothing older says so", () => {
  const timeline = [
    { day: "2023-12-30", kind: "episode" as const, line: "- ep old" },
    { day: "2024-03-02", kind: "episode" as const, line: "- ep march" },
    { day: "2024-04-02", kind: "episode" as const, line: "- ep april" },
  ];
  const out = partLines({
    ...base,
    part: "evidence",
    span: "2024-03",
    timeline,
  });
  expect(out).toContain("- ep march");
  expect(out.join("\n")).not.toContain("ep april");
  expect(out.join("\n")).not.toContain("ep old");
  expect(out[0]).toBe("Evidence in 2024-03:");
  expect(out.at(-1)).toBe("(nothing older)");
});

test("the first page is unchanged: its block, 24 items by whole days, then 'Older' naming before", () => {
  const timeline = [
    ...items("observation", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
    ...items("episode", [12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]),
    ...items("observation", [1]),
  ];
  const out = partLines({ ...base, part: "now", timeline });
  expect(out[0]).toBe("NOW");
  // 24 newest items, then the rest of the last day taken (day 1 has three).
  expect(out.filter((l) => l.startsWith("- episode")).length).toBe(12);
  expect(out.at(-1)).toBe("(nothing older)");
  const many = Array.from({ length: 30 }, (_, i) => ({
    day: day(i + 1),
    kind: "episode" as const,
    line: `- ep ${i + 1}`,
  }));
  const page = partLines({ ...base, part: "now", timeline: many });
  expect(page.filter((l) => l.startsWith("- ep ")).length).toBe(24);
  expect(page.at(-1)).toBe(`Older: the same call with \`before\` ${day(7)}.`);
});

test("next reads end a part with each read's ref and what it holds", () => {
  expect(
    nextReads([
      {
        ref: { part: "evidence", span: "2024", subject: "person:ana" },
        what: "the year",
      },
    ])
  ).toEqual([
    "Next reads (`fetch <ref>`):",
    "- person:ana/evidence/2024: the year",
  ]);
});
