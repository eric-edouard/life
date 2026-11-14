import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { History } from "../records/history";
import type { Unit } from "../records/unit";
import { buildIndex } from "./index-writer";
import { openById } from "./open-by-id";
import { openWithOf } from "./read-open-items";
import { PART_CHARS, parseReadPartRef } from "./read-part";
import {
  heldLines,
  lastExchangeLine,
  nowLines,
  partLines,
} from "./read-person-page";

const madeBy = { engine: "claude", model: "m", prompt: "p", run: "r" } as const;
const partsOf = (m: History["months"][number]) => ("parts" in m ? m.parts : []);
const years = [2021, 2022, 2023, 2024, 2025];
const months = years.flatMap((y) =>
  Array.from({ length: 12 }, (_, i) => `${y}-${String(i + 1).padStart(2, "0")}`)
);
const history: History = {
  months: months.map((month) => ({
    built: "2026-11-11T22:00:00.000Z",
    inputs: month,
    madeBy,
    month,
    parts: [
      {
        quotes: [
          {
            at: `${month}-03T12:00:00.000Z`,
            text: `see you on the ${month} Sunday`,
            writer: "them",
          },
        ],
        summary: `What passed in ${month}: ${"they talked about the house. ".repeat(40)}`,
      },
    ],
  })),
  schemaVersion: 1,
  story: {
    built: "2026-11-11T22:00:00.000Z",
    inputs: "s",
    madeBy,
    text: `Five years of Ana: ${"the story of their friendship. ".repeat(80)}`,
    through: "2025",
  },
} satisfies History;
// Two or three days a month: observations, an episode and a recorded conversation, about 300 characters each.
const timeline = months
  .flatMap((m) =>
    ["03", "12", "25"].flatMap((d) => [
      {
        day: `${m}-${d}`,
        kind: "observation" as const,
        line: `- obs ${m}-${d} ${"x".repeat(300)}`,
      },
      {
        day: `${m}-${d}`,
        kind: "episode" as const,
        line: `- episode ${m}-${d} ${"y".repeat(300)}`,
      },
      ...(d === "12"
        ? [
            {
              day: `${m}-${d}`,
              kind: "conversation" as const,
              line: `- conv ${m}-${d} 10:00: lunch`,
            },
          ]
        : []),
    ])
  )
  .toSorted((a, b) => b.day.localeCompare(a.day));
const counts = ["COUNTS all years", ...years.map((y) => `COUNTS ${y}`)];
const fixed: Record<string, string[]> = {
  now: ["TITLES", "DETAILS", "CLOSE", "LAST EXCHANGE", "OPEN", "SITUATION"],
  page: ["PAGE who they are", "PAGE where things stand"],
  persona: ["PERSONA in short", "PERSONA how each writes"],
};
const held = ({
  sourcesOnly,
  span,
}: {
  sourcesOnly?: boolean;
  span?: string;
} = {}) => [
  ...(span ? [] : ["HELD sources"]),
  ...(sourcesOnly
    ? []
    : months.filter((m) => m.startsWith(span ?? "")).map((m) => `HELD ${m}`)),
];
const noHistory: History = { months: [], schemaVersion: 1, story: null };
const base = {
  candidates: [],
  counts,
  heard: [],
  held,
  heldYears: years.map(String),
  history,
  ref: "person:ana",
  timeline,
};
type Part = Parameters<typeof partLines>[0]["part"];
// What the person's history is, for the read: the whole one, or none read yet.
let shown: History = history;
const read = (
  _name: string,
  o: { before?: string; part?: string; span?: string }
) => {
  const part = (o.part ?? "now") as Part;
  return Promise.resolve(
    partLines({
      ...base,
      ...o,
      fixed: fixed[part] ?? [],
      history: shown,
      part,
    }).join("\n")
  );
};
const open = (id: string) =>
  openById(id, undefined, undefined, read as Parameters<typeof openById>[3]);

const MORE_OPEN =
  /\d+ more open with them, ranked lower: `read_matters` with person ana/;
const SPANNED_EVIDENCE = /\/evidence\/\d{4}/;
const NEXT = /^- (\S+): /gm;
const YEAR_BEFORE = /person:ana\/year\/2023\/before\/(\S+):/;
const OBS_DAY = /^- obs (\S+) /;
const OLDER = /^Older: the same call with `before` (\S+)\.$/;

/** Every part reachable from `now` by next reads only, level by level, each opened through `openById`. */
async function reachable(
  level = ["person:ana/now"],
  seen = new Map<string, string>()
): Promise<Map<string, string>> {
  const fresh = [...new Set(level)].filter((id) => !seen.has(id));
  if (fresh.length === 0) {
    return seen;
  }
  for (const id of fresh) {
    expect(parseReadPartRef(id)).toHaveProperty("ref");
  }
  const texts = await Promise.all(fresh.map(open));
  const next = texts.flatMap((text, i) => {
    expect(text).not.toContain("is not a read part");
    expect(text).not.toContain("no part ");
    seen.set(fresh[i] as string, text);
    const reads = text.split("Next reads (`fetch <ref>`):\n")[1] ?? "";
    // Only the oldest evidence has nothing deeper or older to name.
    expect(reads || text.split("\n").at(-1)).toBe(reads || "(nothing older)");
    return [...reads.matchAll(NEXT)].map((m) => m[1] as string);
  });
  return reachable(next, seen);
}

test("every part fits its size, ends with next reads that parse and open, and the whole is reached from `now` alone", async () => {
  const seen = await reachable();
  const parts = new Set([...seen.keys()].map((id) => id.split("/")[1]));
  expect([...parts].sort()).toEqual([
    "evidence",
    "month",
    "now",
    "page",
    "persona",
    "story",
    "year",
  ]);
  // A month and a year each have their part; no span is left unreachable.
  for (const m of months) {
    expect(seen.has(`person:ana/month/${m}`)).toBe(true);
  }
  for (const y of years) {
    expect(seen.has(`person:ana/year/${y}`)).toBe(true);
  }
  // A day (here a month's entry, up to 1,200 characters) is never cut, so a part may pass the size by one.
  const biggest = Math.max(
    ...history.months.map((m) => partsOf(m)[0]?.summary.length ?? 0)
  );
  for (const [id, text] of seen) {
    expect(text.length, id).toBeLessThan(PART_CHARS + biggest + 600);
  }
});

test("every line of the old first page sits in exactly one part", async () => {
  const seen = await reachable();
  // The unspanned reads: a span's evidence is another view of the same days.
  const own = [...seen].filter(([id]) => !SPANNED_EVIDENCE.test(id));
  const lines = own.flatMap(([, text]) => text.split("\n"));
  const old = [
    ...Object.values(fixed).flat(),
    ...counts,
    `Over the years (through 2025): ${history.story?.text}`,
    ...months.map(
      (m) =>
        `- ${m} (chats and mail only): ${partsOf(history.months.find((x) => x.month === m) as never)[0]?.summary}`
    ),
    ...months.map((m) => `- "see you on the ${m} Sunday" (${m}-03, them)`),
    ...held(),
    ...timeline.map((t) => t.line),
  ];
  for (const l of old) {
    expect(lines.filter((x) => x === l).length, l.slice(0, 60)).toBe(1);
  }
});

test("`now` with 200 open items still fits the part, and says how many more there are", () => {
  const items = Array.from({ length: 200 }, (_, i) => ({
    at: `2026-10-${String((i % 28) + 1).padStart(2, "0")}T10:00:00.000Z`,
    id: `obs_${String(i).padStart(12, "0")}`,
    kind: "to_do" as const,
    line: `- to do ${i}: ${"he owes them a long errand ".repeat(11)}`,
    people: ["person:ana"],
    person: "person:ana",
    when: "2026-11-14",
  }));
  const nowBlock = nowLines({
    after: ["SITUATION"],
    before: ["TITLES".repeat(100), "DETAILS", "CLOSE", "LAST EXCHANGE"],
    open: (room) =>
      openWithOf("person:ana", {
        goals: [],
        items,
        room,
        today: "2026-11-14",
      }),
  });
  const text = partLines({ ...base, fixed: nowBlock, part: "now" }).join("\n");
  expect(text.length).toBeLessThan(PART_CHARS);
  expect(text).toContain("to do ");
  expect(text).toMatch(MORE_OPEN);
  expect(text).toContain("SITUATION");
  expect(text).toContain("Next reads");
});

test("a person with a timeline and no history: every month's 'what Life holds' line is still reached from `now`", async () => {
  shown = noHistory;
  try {
    const seen = await reachable();
    const lines = [...seen]
      .filter(([id]) => !SPANNED_EVIDENCE.test(id))
      .flatMap(([, text]) => text.split("\n"));
    for (const l of [
      ...Object.values(fixed).flat(),
      ...counts,
      ...held(),
      ...timeline.map((t) => t.line),
    ]) {
      expect(lines.filter((x) => x === l).length, l.slice(0, 60)).toBe(1);
    }
    for (const y of years) {
      expect(seen.get(`person:ana/year/${y}`)).toContain(
        `(no month of ${y} was read yet)`
      );
    }
  } finally {
    shown = history;
  }
});

test("year pages back by `before`, newest month first, and each month names its days", async () => {
  const first = await open("person:ana/year/2023");
  expect(first).toContain("- 2023-12 (chats and mail only):");
  const next = YEAR_BEFORE.exec(first);
  expect(next).not.toBeNull();
  const second = await open(`person:ana/year/2023/before/${next?.[1]}`);
  expect(second).not.toContain("- 2023-12 ");
  expect(second).not.toContain("HELD 2023-01");
  const month = await open("person:ana/month/2023-03");
  expect(month).toContain(
    '- "see you on the 2023-03 Sunday" (2023-03-03, them)'
  );
  expect(month).toContain(
    "- 2023-03-12: 1 observation, 1 episode, 1 conversation"
  );
  expect(month).toContain("person:ana/evidence/2023-03:");
});

test("a month in two sizes and a month read in parts show side by side: headline and old line in the year, sentences with their days and the old quotes in the month", async () => {
  const two = {
    built: "2026-11-11T22:00:00.000Z",
    headline: "Ana took a job in Lyon and moves in June.",
    inputs: "two",
    madeBy,
    month: "2026-03",
    sentences: [
      {
        days: ["2026-03-02"],
        text: "On 2 March Ana said she is moving to Lyon.",
      },
      {
        days: ["2026-03-09", "2026-03-17"],
        text: "He lent her his van and they settled the deposit.",
      },
    ],
  };
  shown = {
    ...history,
    months: [...history.months, two],
  };
  try {
    const year = await open("person:ana/year/2026");
    expect(year).toContain(`- 2026-03: ${two.headline}`);
    const old = await open("person:ana/year/2021");
    expect(old).toContain("- 2021-12 (chats and mail only): What passed");
    const month = await open("person:ana/month/2026-03");
    expect(month).toContain(
      "2026-03 between them and him, from everything Life holds of the month (each sentence ends with the days it rests on):"
    );
    expect(month).toContain(
      "- On 2 March Ana said she is moving to Lyon. (2026-03-02)"
    );
    expect(month).toContain(
      "- He lent her his van and they settled the deposit. (2026-03-09, 2026-03-17)"
    );
    expect(await open("person:ana/month/2021-12")).toContain(
      '- "see you on the 2021-12 Sunday" (2021-12-03, them)'
    );
    expect(await open("person:ana/now")).toContain(
      "person:ana/year/2026: 2026: each month between them in one line"
    );
  } finally {
    shown = history;
  }
});

test("someone only heard has no parts: `now` is their evidence, paged back with `before`, ending with the older call", () => {
  const heard = { ...base, heard: [{ name: "Zed" }], ref: undefined };
  let before: string | undefined;
  const days = new Set<string>();
  for (let page = 0; page < 200; page += 1) {
    const out = partLines({ ...heard, before, fixed: [], part: "now" });
    expect(out.join("\n")).not.toContain("Next reads");
    expect(out).toContain("HELD 2021-01");
    for (const l of out) {
      const day = OBS_DAY.exec(l)?.[1];
      if (day) {
        expect(days.has(`${day}${l}`)).toBe(false);
        days.add(`${day}${l}`);
      }
    }
    const older = OLDER.exec(out.at(-1) as string);
    if (!older) {
      expect(out.at(-1)).toBe("(nothing older)");
      expect(days.size).toBe(months.length * 3);
      return;
    }
    [, before] = older;
  }
  throw new Error("never ended");
});

test("the last exchange: when, who opened it, how many each sent", () => {
  const row = (start: string, heOpened: boolean, sent: number, got: number) =>
    ({ got, heOpened, sent, start }) as never;
  expect(
    lastExchangeLine({
      rows: [
        row("2024-03-01T10:00:00.000Z", true, 1, 1),
        row("2025-06-02T10:00:00.000Z", false, 4, 2),
      ],
    })
  ).toEqual([
    "Last exchange: 2025-06-02, opened by them; he sent 4, they sent 2.",
  ]);
  expect(lastExchangeLine({ rows: [] })).toEqual([]);
  expect(lastExchangeLine(null)).toEqual([]);
});

test("what Life holds, by year with the sources, or by month inside one year", async () => {
  const dir = await mkdtemp(join(tmpdir(), "life-held-"));
  const path = join(dir, "i.sqlite");
  const unit = (date: string, n: number) =>
    ({
      date,
      id: `unit_00000000000${n}`,
      people: ["person:ana"],
      source: "lifelog",
      title: "t",
    }) as unknown as Unit;
  const units = [
    unit("2025-01-10", 1),
    unit("2025-03-10", 2),
    unit("2026-02-10", 3),
  ];
  buildIndex(
    [],
    path,
    {
      corrections: [],
      latest: new Map(),
      live: new Set(units.map((u) => u.id)),
      retired: new Map(),
    },
    units.map((u) => ({ unit: u }))
  );
  const db = new Database(path, { readonly: true });
  try {
    const sources = heldLines(db, "person:ana", [], { sourcesOnly: true });
    expect(sources.some((l) => l.startsWith("- lifelog: 3 units"))).toBe(true);
    expect(sources.join("\n")).not.toContain("By month");
    const byMonth = heldLines(db, "person:ana", [], { span: "2025" });
    expect(byMonth.filter((l) => l.startsWith("- 2025-")).length).toBe(2);
    expect(byMonth.join("\n")).not.toContain("2026");
    expect(byMonth.join("\n")).not.toContain("What Life holds about them");
    expect(byMonth.join("\n")).not.toContain("Not in Life");
  } finally {
    db.close();
    rmSync(dir, { force: true, recursive: true });
  }
});
