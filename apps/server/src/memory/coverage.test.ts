import { expect, test } from "bun:test";
import type { Published } from "../records/publication";
import { coverageOf, notCapturedOf, type recordingOf } from "./coverage";
import { coveredLines } from "./read-day";

const source = (
  name: "imessage" | "whatsapp" | "line" | "lifelog",
  extra: Partial<Parameters<typeof coverageOf>[1]["sources"][number]> = {}
) => ({
  hasUnit: false,
  label: name,
  name,
  ...extra,
});
const line = (from: string, to: string, sources: Published["sources"]) =>
  ({
    at: `${to}T22:30:00.000Z`,
    from,
    schemaVersion: 1,
    sources,
    to,
  }) satisfies Published;
// The record starts with the night of 13 Nov, which read its last 7 days.
const lines = [line("2026-11-07", "2026-11-13", ["imessage", "whatsapp"])];
const coverageOfDay = (
  day: string,
  o: Partial<Parameters<typeof coverageOf>[1]>
) =>
  Object.fromEntries(
    coverageOf(day, {
      isPublished: true,
      lines,
      sources: [],
      today: "2026-11-20",
      ...o,
    }).map((c) => [c.name, c.why ? `${c.state}: ${c.why}` : c.state])
  );

test("a day is captured only when something says so: a unit that day, or a publication that read the source", () => {
  expect(
    coverageOfDay("2026-11-10", {
      sources: [source("imessage"), source("line", { hasUnit: true })],
    })
  ).toEqual({ imessage: "captured", line: "captured" });
});

test("not seen: before a source's first day, a day never published, a source the publication did not read, a week no night read", () => {
  expect(
    coverageOfDay("2026-11-10", {
      sources: [source("line", { firstDay: "2026-10-30" })],
    })
  ).toEqual({ line: "not_seen: Life did not read it this day" });
  expect(
    coverageOfDay("2026-10-01", {
      sources: [source("line", { firstDay: "2026-10-30" })],
    })
  ).toEqual({ line: "not_seen: before its first day, 2026-10-30" });
  // A day the history could not date: no units file.
  expect(
    coverageOfDay("2026-11-10", {
      isPublished: false,
      sources: [source("imessage")],
    })
  ).toEqual({ imessage: "not_seen: Life read nothing this day" });
  // After the record began, a day no publication covers (the nights failed for a week): never "quiet".
  expect(
    coverageOfDay("2026-11-16", { sources: [source("imessage")] })
  ).toEqual({
    imessage: "not_seen: Life read nothing this day",
  });
});

test("the pendant with nothing held: what lifelog said it recorded, never the record of what Life read", () => {
  // lifelog can tell since 8 Oct and was last asked on the night of 12 Nov.
  const kept = {
    built: "2026-11-12T03:00:00.000Z",
    days: ["2026-11-09", "2026-11-10"],
    since: "2026-10-08T03:00:00.000Z",
  };
  const pendant = (recorded: Parameters<typeof recordingOf>[0], day: string) =>
    coverageOfDay(day, {
      lines: [line("2026-11-07", "2026-11-13", ["lifelog"])],
      sources: [source("lifelog", { recorded })],
    }).lifelog;
  // Recording with nobody speaking is capture; a day not recorded on is the pendant off, not a quiet day.
  expect(pendant(kept, "2026-11-10")).toBe("captured");
  expect(pendant(kept, "2026-11-11")).toBe(
    "not_seen: the pendant recorded nothing this day"
  );
  expect(pendant(kept, "2026-10-01")).toBe(
    "unknown: nothing held; lifelog cannot tell whether it was recording before 2026-10-08"
  );
  expect(pendant({ ...kept, days: [], since: null }, "2026-11-10")).toBe(
    "unknown: nothing held; lifelog cannot tell whether it was recording before now"
  );
  // The day it was last asked on, and after: its later hours were never said.
  expect(pendant(kept, "2026-11-12")).toBe(
    "unknown: nothing held; lifelog was last asked on 2026-11-12"
  );
  expect(pendant(null, "2026-11-10")).toBe(
    "unknown: nothing held; lifelog was never asked whether it was recording"
  );
  // A unit that day needs no asking; today is being captured, whatever last night's file says.
  expect(
    coverageOfDay("2026-11-10", {
      sources: [source("lifelog", { hasUnit: true })],
    })
  ).toEqual({ lifelog: "captured" });
  expect(pendant(kept, "2026-11-20")).toBe("captured");
});

test("unknown: a day before the record with no unit", () => {
  expect(
    coverageOfDay("2026-10-01", { sources: [source("imessage")] })
  ).toEqual({
    imessage: "unknown: Life kept no record of what it read before 2026-11-13",
  });
});

test("today: a readable source is being captured, one that can't be read is not seen", () => {
  expect(
    coverageOfDay("2026-11-20", {
      sources: [
        source("imessage"),
        source("whatsapp", { missing: "Full Disk Access for Life" }),
      ],
    })
  ).toEqual({
    imessage: "captured",
    whatsapp: "not_seen: can't be read now: Full Disk Access for Life",
  });
});

test("the day read's lines name each state once, with why; no capturing source, no block", () => {
  expect(
    coveredLines([
      { label: "iMessage", name: "imessage", state: "captured" },
      { label: "WhatsApp", name: "whatsapp", state: "captured" },
      {
        label: "LINE",
        name: "line",
        state: "not_seen",
        why: "before its first day, 2026-10-30",
      },
      {
        label: "Pendant",
        name: "lifelog",
        state: "unknown",
        why: "nothing held; lifelog could not be asked whether it was recording",
      },
    ])
  ).toEqual([
    "",
    'Coverage (sources that capture on their own; "not seen" is not "quiet"):',
    "- Captured: iMessage, WhatsApp",
    "- Not seen: LINE (before its first day, 2026-10-30)",
    "- Unknown: Pendant (nothing held; lifelog could not be asked whether it was recording)",
  ]);
  expect(coveredLines([])).toEqual([]);
});

test("by month, the days a source was not captured, from its first day on", () => {
  const day = (state: "captured" | "not_seen" | "unknown") => [
    { label: "LINE", name: "line" as const, state },
    {
      label: "iMessage",
      name: "imessage" as const,
      state: "not_seen" as const,
    },
  ];
  const missed = notCapturedOf(
    new Map([
      ["2026-10-29", day("not_seen")],
      ["2026-10-30", day("unknown")],
      ["2026-10-31", day("captured")],
      ["2026-11-01", day("not_seen")],
      ["2026-11-02", day("not_seen")],
    ]),
    // iMessage is not asked about: it is not one of the sources given.
    [{ firstDay: "2026-10-30", label: "LINE", name: "line" }]
  );
  expect([...missed.keys()]).toEqual(["2026-10", "2026-11"]);
  expect([...(missed.get("2026-10")?.unknown ?? [])]).toEqual([["line", 1]]);
  expect(missed.get("2026-10")?.not_seen.size).toBe(0);
  expect([...(missed.get("2026-11")?.not_seen ?? [])]).toEqual([["line", 2]]);
});
