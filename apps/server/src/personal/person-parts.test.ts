import { expect, test } from "bun:test";
import { setSettings, settings } from "../core/settings";
import { exchangeCountsOf } from "../memory/exchange-counts";
import { openById } from "../memory/open-by-id";
import { knowsOf } from "../memory/person-now";
import {
  ADD_ON_PARTS,
  PART_CHARS,
  parseReadPartRef,
  readPartRefOf,
} from "../memory/read-part";
import {
  nowReads,
  offersOf,
  type PartInputs,
  partLines,
} from "../memory/read-person-page";
import type { History } from "../records/history";
import type { SourceEvent } from "../records/source";
import { baseOf, monthsOf } from "../test-data/person-read";
import {
  exchangeCountsBlock,
  monthLines,
  personalParts,
  personaPartLines,
  storyLines,
  yearLines,
} from "./person-parts";

const madeBy = { engine: "claude", model: "m", prompt: "p", run: "r" } as const;
const years = [2021, 2022, 2023, 2024, 2025];
const months = monthsOf(years);
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
};
const PERSONAL_PART = /persona|story/;
const msg = (day: string, minute: number, fromMe: boolean): SourceEvent => ({
  at: new Date(
    Date.parse(`${day}T12:00:00.000Z`) + minute * 60_000
  ).toISOString(),
  chat: "+1",
  fromMe,
  id: `${day}:${minute}`,
  sender: fromMe ? "me" : "+1",
  source: "whatsapp",
  text: "x",
});
const exchange = {
  built: "2026-11-11T22:30:00.000Z",
  rows: exchangeCountsOf(years.map((y) => msg(`${y}-03-01`, 0, true))),
  sources: ["whatsapp"],
};
const counts = exchangeCountsBlock(exchange).filter(Boolean);
const fixed: Record<string, string[]> = {
  page: ["PAGE who they are", "PAGE where things stand"],
  persona: ["PERSONA in short", "PERSONA what they want"],
};
const noHistory: History = { months: [], schemaVersion: 1, story: null };
const shared = baseOf(years);
const { held, timeline } = shared;
const base = {
  ...shared,
  offers: [
    { about: "what they are like", part: "persona" as const },
    { about: "the years between them", part: "story" as const },
  ],
};
type Part = PartInputs["part"];
// What the person's history is, for the read: the whole one, or none read yet.
let shown = history;
const rendered: Partial<Record<Part, (o: PartInputs) => string[]>> = {
  month: (o) => monthLines(shown, o),
  persona: (o) => personaPartLines(fixed.persona as string[], o),
  story: (o) => storyLines(shown, exchange, o),
  year: (o) => yearLines(shown, o),
};
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
      part,
      personal: rendered[part],
    }).join("\n")
  );
};
const open = async (id: string) =>
  (await openById(
    id,
    undefined,
    undefined,
    read as Parameters<typeof openById>[3]
  )) as string;
/** What `now` offers to read (its `knows`): where every walk starts. */
const fromNow = nowReads({ ...base, fixed: [], part: "now" }).map((r) =>
  readPartRefOf(r.ref)
);

const SPANNED_EVIDENCE = /\/evidence\/\d{4}/;
const NEXT = /^- (\S+): /gm;
const YEAR_BEFORE = /person:ana\/year\/2023\/before\/(\S+):/;

/** Every part reachable from what `now` offers by next reads only, level by level, each opened through `openById`. */
async function reachable(
  level = fromNow,
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
    ...history.months.map((m) => m.parts[0]?.summary.length ?? 0)
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
        `- ${m}: ${history.months.find((x) => x.month === m)?.parts[0]?.summary}`
    ),
    ...months.map((m) => `- "see you on the ${m} Sunday" (${m}-03, them)`),
    ...held(),
    ...timeline.map((t) => t.line),
  ];
  for (const l of old) {
    expect(lines.filter((x) => x === l).length, l.slice(0, 60)).toBe(1);
  }
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
  expect(first).toContain("- 2023-12:");
  const next = YEAR_BEFORE.exec(first);
  expect(next).not.toBeNull();
  const second = await open(`person:ana/year/2023/before/${next?.[1]}`);
  expect(second).not.toContain("- 2023-12:");
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

test("the counts of a pair: all years, then each year an exchange started in, newest first; nothing when none was counted", () => {
  const rows = exchangeCountsOf([
    msg("2025-03-01", 0, true),
    msg("2025-03-01", 30, false),
    msg("2026-10-01", 0, false),
    msg("2026-10-01", 10, true),
    msg("2026-10-02", 0, true),
  ]);
  const counted = {
    built: "2026-11-11T22:30:00.000Z",
    rows,
    sources: ["whatsapp", "mail"],
  };
  const block = exchangeCountsBlock(counted);
  expect(block[0]).toStartWith(
    "Counted by code between them and Test, through 2026-11-1"
  );
  expect(block[0]).toContain("whatsapp, mail");
  expect(block[0]).toContain("until 6 hours of quiet");
  expect(block[1]).toStartWith("- all years: messages on 3 days; Test sent 3");
  expect(block.slice(2).map((l) => l.slice(0, 7))).toEqual([
    "- 2026:",
    "- 2025:",
    "",
  ]);
  expect(exchangeCountsBlock({ ...counted, rows: [] })).toEqual([]);
  expect(exchangeCountsBlock(null)).toEqual([]);
});

test("a part is offered only while its add-on is on: none, and `now` names no persona nor story", () => {
  const was = settings().personal;
  try {
    setSettings({ personal: null });
    expect(personalParts()).toEqual({});
    const now = nowReads({
      ...base,
      fixed: [],
      offers: offersOf({}),
      part: "now",
    }).map((r) => readPartRefOf(r.ref));
    expect(now.join("\n")).not.toMatch(PERSONAL_PART);
    expect(now).toContain("person:ana/page");
    setSettings({ personal: { personas: {} } });
    expect(Object.keys(personalParts())).toEqual(["persona"]);
    setSettings({ personal: { histories: { from: "2024-01" } } });
    expect(Object.keys(personalParts()).sort()).toEqual([
      "month",
      "story",
      "year",
    ]);
    setSettings({ personal: { histories: { from: "2024-01" }, personas: {} } });
    expect(Object.keys(personalParts()).sort()).toEqual(
      [...ADD_ON_PARTS].sort()
    );
    const offers = offersOf(personalParts());
    expect(offers.map((o) => o.part)).toEqual(["persona", "story"]);
  } finally {
    setSettings({ personal: was ?? null });
  }
});

test("the persona's next reads name the story only when the story is offered", () => {
  const withStory = personaPartLines(["P"], {
    ...base,
    fixed: [],
    part: "persona",
  }).join("\n");
  const without = personaPartLines(["P"], {
    ...base,
    fixed: [],
    offers: [],
    part: "persona",
  }).join("\n");
  expect(withStory).toContain("person:ana/story");
  expect(without).not.toContain("person:ana/story");
});

test("an empty persona, as its part renders it with its next reads, is not in `now`'s knows", () => {
  const persona = personaPartLines([], { ...base, fixed: [], part: "persona" });
  expect(
    knowsOf(
      [{ ref: { part: "persona", subject: "person:ana" } }],
      () => persona
    )
  ).toEqual([]);
});
