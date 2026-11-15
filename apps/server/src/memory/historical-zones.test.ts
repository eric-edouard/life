import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  fixedZoneOf,
  historicalZonesOf,
  mailEvidenceOf,
  photoEvidenceOf,
  prepareHistoricalZones,
  readEvidence,
  settledDays,
  supersedingRuns,
} from "./historical-zones";
import { EPISODES, MEMORY, UNITS, ZONES } from "./memory-files";
import { zoneAt, zones } from "./zones";

const sent = (day: string, offset: string) => ({
  date: `${day} 12:00:00 ${offset}`,
});
const photo = (day: string, offset: number) => ({
  at: `${day}T12:00:00Z`,
  offset,
});
const evidenceOf = (
  mail: Parameters<typeof mailEvidenceOf>[0] = [],
  photos: Parameters<typeof photoEvidenceOf>[0] = []
) => ({ mail: mailEvidenceOf(mail), photos: photoEvidenceOf(photos) });

const line = (from: string, tz: string, source?: "mail" | "photos") =>
  JSON.stringify({ from, schemaVersion: 1, source, tz });
const unitLine = (day: string) =>
  `${JSON.stringify({ date: day, end: `${day}T12:00:00Z`, hash: "a".repeat(16), id: "unit_aaaaaaaaaaaa", key: "test", people: [], refs: ["test"], schemaVersion: 1, source: "imessage", start: `${day}T12:00:00Z`, stats: { chars: 20, fromMe: 1, items: 1 }, title: "Example" })}\n`;

test("an offset is a whole-hour zone, a quarter hour that defers, or noise that says nothing", () => {
  expect(fixedZoneOf(420)).toBe("Etc/GMT-7");
  expect(fixedZoneOf(-300)).toBe("Etc/GMT+5");
  expect(fixedZoneOf(0)).toBe("Etc/GMT");
  expect(fixedZoneOf(330)).toBeNull();
  expect(fixedZoneOf(345)).toBeNull();
  expect(fixedZoneOf(121)).toBeUndefined();
  expect(fixedZoneOf(900)).toBeUndefined();
});

test("sent mail says only whole-hour zones: -0000, a missing header, a quarter hour and noise say nothing; the day is the sender's", () => {
  expect(
    mailEvidenceOf([
      sent("2023-01-02", "-0000"),
      {},
      sent("2023-01-04", "+0201"),
      { date: "2 Jan 2023 00:30:00 +0530" },
      { date: "2 Jan 2023 00:30:00 +0100" },
    ])
  ).toEqual([{ day: "2023-01-02", zone: "Etc/GMT-1" }]);
});

test("gaps take the nearest known day, ties earlier; split mail is a gap, unless it names both differing sides (a travel day)", () => {
  const report = historicalZonesOf(
    evidenceOf([
      sent("2023-01-02", "+0700"),
      sent("2023-01-06", "-0500"),
      sent("2023-01-07", "+0530"),
      sent("2023-01-08", "+0700"),
      sent("2023-01-08", "-0500"),
      sent("2023-01-10", "+0700"),
      sent("2023-01-12", "+0700"),
      sent("2023-01-12", "+0100"),
      sent("2023-01-13", "+0700"),
    ]),
    { from: "2023-01-01", to: "2023-01-13" }
  );
  expect(report.gaps).toEqual([
    "2023-01-01",
    "2023-01-03",
    "2023-01-04",
    "2023-01-05",
    "2023-01-07",
    "2023-01-09",
    "2023-01-11",
    "2023-01-12",
  ]);
  expect(report.deferred).toEqual(["2023-01-08"]);
  expect(report.runs).toEqual([
    { from: "2022-12-31T17:00:00.000Z", source: "mail", tz: "Etc/GMT-7" },
    { from: "2023-01-05T05:00:00.000Z", source: "mail", tz: "Etc/GMT+5" },
    { from: "2023-01-08T17:00:00.000Z", source: "mail", tz: "Etc/GMT-7" },
  ]);
});

test("photos that agree beat mail and open runs of their own; photos that split fall back to mail", () => {
  const report = historicalZonesOf(
    evidenceOf(
      [
        sent("2023-01-01", "+0700"),
        sent("2023-01-02", "+0700"),
        sent("2023-01-03", "+0700"),
      ],
      [
        photo("2023-01-02", -300),
        photo("2023-01-03", -300),
        photo("2023-01-03", 420),
      ]
    ),
    { from: "2023-01-01", to: "2023-01-03" }
  );
  expect(report.runs).toEqual([
    { from: "2022-12-31T17:00:00.000Z", source: "mail", tz: "Etc/GMT-7" },
    { from: "2023-01-02T05:00:00.000Z", source: "photos", tz: "Etc/GMT+5" },
    { from: "2023-01-02T17:00:00.000Z", source: "mail", tz: "Etc/GMT-7" },
  ]);
  expect(report.deferred).toEqual([]);
});

test("a photo's quarter hour defers its day; a noise offset is ignored, so mail decides", () => {
  const report = historicalZonesOf(
    evidenceOf(
      [
        sent("2023-01-01", "+0700"),
        sent("2023-01-02", "+0700"),
        sent("2023-01-03", "+0700"),
      ],
      [photo("2023-01-02", 330), photo("2023-01-03", 121)]
    ),
    { from: "2023-01-01", to: "2023-01-03" }
  );
  expect(report.deferred).toEqual(["2023-01-02"]);
  expect(report.runs).toHaveLength(1);
});

test("a date-line offset jump cannot publish decreasing run boundaries", () => {
  const report = historicalZonesOf(
    evidenceOf([sent("2023-01-01", "-1200"), sent("2023-01-02", "+1400")]),
    { from: "2023-01-01", to: "2023-01-02" }
  );
  expect(report.deferred).toEqual(["2023-01-02"]);
  expect(report.runs).toHaveLength(1);
});

test("the last day of the era is deferred when it would end after the first recorded zone begins", () => {
  const evidence = evidenceOf([sent("2023-01-01", "+0700")]);
  const window = { from: "2023-01-01", to: "2023-01-02" };
  expect(
    historicalZonesOf(evidence, window, "2023-01-02T17:00:00.000Z").deferred
  ).toEqual([]);
  expect(
    historicalZonesOf(evidence, window, "2023-01-02T16:00:00.000Z").deferred
  ).toEqual(["2023-01-02"]);
});

test("supersedes by appending at each change, a later line at the same `from` wins, and a second pass appends nothing", () => {
  const stored = [
    {
      from: Date.parse("2023-01-01T00:00:00Z"),
      source: "mail" as const,
      tz: "Etc/GMT",
    },
    {
      from: Date.parse("2023-01-03T00:00:00Z"),
      source: "mail" as const,
      tz: "Etc/GMT-1",
    },
  ];
  const derived = [
    {
      from: "2022-12-31T17:00:00.000Z",
      source: "photos" as const,
      tz: "Etc/GMT-7",
    },
    {
      from: "2023-01-03T00:00:00.000Z",
      source: "mail" as const,
      tz: "Etc/GMT-1",
    },
    {
      from: "2023-01-04T00:00:00.000Z",
      source: "mail" as const,
      tz: "Etc/GMT-2",
    },
  ];
  const lines = supersedingRuns(stored, derived, new Set());
  expect(lines).toEqual([
    { from: "2022-12-31T17:00:00.000Z", source: "photos", tz: "Etc/GMT-7" },
    { from: "2023-01-01T00:00:00.000Z", source: "photos", tz: "Etc/GMT-7" },
    { from: "2023-01-04T00:00:00.000Z", source: "mail", tz: "Etc/GMT-2" },
  ]);
  const next = [
    ...stored,
    ...lines.map((l) => ({ ...l, from: Date.parse(l.from) })),
  ].toSorted((a, b) => a.from - b.from);
  expect(supersedingRuns(next, derived, new Set())).toEqual([]);
  expect(
    supersedingRuns(
      stored,
      derived,
      new Set(),
      Date.parse("2022-12-31T18:00:00Z")
    )
  ).toHaveLength(1);
});

test("a settled day keeps its stored zone", () => {
  const stored = [
    {
      from: Date.parse("2023-01-01T00:00:00Z"),
      source: "mail" as const,
      tz: "Etc/GMT",
    },
  ];
  const derived = [
    {
      from: "2023-01-01T00:00:00.000Z",
      source: "mail" as const,
      tz: "Etc/GMT-1",
    },
  ];
  const lines = supersedingRuns(stored, derived, new Set(["2023-01-02"]));
  expect(lines.map((l) => [l.from, l.tz])).toEqual([
    ["2023-01-01T00:00:00.000Z", "Etc/GMT-1"],
    ["2023-01-02T00:00:00.000Z", "Etc/GMT"],
    ["2023-01-03T00:00:00.000Z", "Etc/GMT-1"],
  ]);
});

test("the settled days: those a record cites, those from the first episode, and deferred ones holding units, each with one neighbour", async () => {
  const cited = join(MEMORY, "cited-test.jsonl");
  const episode = join(EPISODES, "2018-01-20.jsonl");
  mkdirSync(UNITS, { recursive: true });
  mkdirSync(EPISODES, { recursive: true });
  writeFileSync(join(UNITS, "2018-01-02.jsonl"), unitLine("2018-01-02"));
  writeFileSync(join(UNITS, "2018-01-10.jsonl"), unitLine("2018-01-10"));
  writeFileSync(
    join(UNITS, "2018-01-12.jsonl"),
    `${unitLine("2018-01-12")}`.replace(
      "unit_aaaaaaaaaaaa",
      "unit_bbbbbbbbbbbb"
    )
  );
  writeFileSync(cited, '{"unit":"unit_bbbbbbbbbbbb"}\n');
  writeFileSync(episode, "");
  try {
    const settled = await settledDays(
      { from: "2018-01-01", to: "2018-01-22" },
      ["2018-01-10", "2018-01-05"],
      new Set(["2018-01-02", "2018-01-10", "2018-01-12"])
    );
    expect([...settled].sort()).toEqual([
      "2018-01-09",
      "2018-01-10",
      "2018-01-11",
      "2018-01-12",
      "2018-01-13",
      ...["19", "20", "21", "22", "23"].map((d) => `2018-01-${d}`),
    ]);
  } finally {
    for (const f of [
      cited,
      episode,
      join(UNITS, "2018-01-02.jsonl"),
      join(UNITS, "2018-01-10.jsonl"),
      join(UNITS, "2018-01-12.jsonl"),
    ]) {
      rmSync(f);
    }
    rmSync(UNITS, { force: true, recursive: true }); // test data has no units dir: other tests assert it
  }
});

test("zones follow the derivation over the whole era only: a narrower window appends nothing, and a pass twice changes nothing", async () => {
  const was = readFileSync(ZONES, "utf8");
  const evidence = () =>
    evidenceOf(
      [sent("2018-01-01", "+0700"), sent("2018-01-10", "+0700")],
      [photo("2018-01-05", -300)]
    );
  const whole = { from: "2018-01-01", to: "2018-01-31" };
  try {
    writeFileSync(
      ZONES,
      `${line("2018-01-01T00:00:00Z", "Etc/GMT", "mail")}\n${line("2018-02-01T00:00:00Z", "Etc/GMT")}\n`
    );
    const initial = readFileSync(ZONES, "utf8");
    await prepareHistoricalZones(
      { from: "2018-01-03", to: "2018-01-20" },
      evidence
    );
    expect(readFileSync(ZONES, "utf8")).toBe(initial);
    await prepareHistoricalZones(whole, evidence);
    expect(zones().filter((z) => z.source === "photos").length).toBeGreaterThan(
      0
    );
    expect(zoneAt("2018-01-02T12:00:00Z")).toBe("Etc/GMT-7");
    expect(zoneAt("2018-01-06T12:00:00Z")).toBe("Etc/GMT+5");
    expect(zoneAt("2018-01-20T12:00:00Z")).toBe("Etc/GMT-7");
    expect(zoneAt("2018-02-01T12:00:00Z")).toBe("Etc/GMT");
    const after = readFileSync(ZONES, "utf8");
    await prepareHistoricalZones(whole, evidence);
    expect(readFileSync(ZONES, "utf8")).toBe(after);
  } finally {
    writeFileSync(ZONES, was);
  }
});

test("a day a record cites keeps its zone, and so its units", async () => {
  const was = readFileSync(ZONES, "utf8");
  const cited = join(MEMORY, "cited-test.jsonl");
  mkdirSync(UNITS, { recursive: true });
  writeFileSync(join(UNITS, "2018-01-06.jsonl"), unitLine("2018-01-06"));
  writeFileSync(cited, '{"unit":"unit_aaaaaaaaaaaa"}\n');
  try {
    writeFileSync(
      ZONES,
      `${line("2018-01-01T00:00:00Z", "Etc/GMT", "mail")}\n${line("2018-02-01T00:00:00Z", "Etc/GMT")}\n`
    );
    await prepareHistoricalZones({ from: "2018-01-01", to: "2018-01-31" }, () =>
      evidenceOf(
        [sent("2018-01-01", "+0700")],
        [photo("2018-01-02", -300), photo("2018-01-20", -300)]
      )
    );
    expect(zoneAt("2018-01-03T12:00:00Z")).toBe("Etc/GMT+5");
    expect(zoneAt("2018-01-06T12:00:00Z")).toBe("Etc/GMT");
    expect(zoneAt("2018-01-15T12:00:00Z")).toBe("Etc/GMT+5");
  } finally {
    rmSync(cited);
    rmSync(UNITS, { force: true, recursive: true });
    writeFileSync(ZONES, was);
  }
});

test("a source that is not ready gives no evidence, and its store is not read", () => {
  expect(readEvidence()).toEqual({ mail: [], photos: [] });
});
