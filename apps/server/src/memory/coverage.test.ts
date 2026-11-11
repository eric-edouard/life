import { expect, test } from "bun:test";
import type { Published } from "../records/publication";
import { coverageOf } from "./coverage";
import { coveredLines } from "./read-day";

const source = (
  name: "imessage" | "whatsapp" | "line" | "lifelog",
  extra: { firstDay?: string; hasUnit?: boolean; missing?: string } = {}
) => ({
  hasUnit: false,
  isVoice: name === "lifelog",
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
const stateOf = (day: string, o: Partial<Parameters<typeof coverageOf>[1]>) =>
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
    stateOf("2026-11-10", {
      sources: [source("imessage"), source("line", { hasUnit: true })],
    })
  ).toEqual({ imessage: "captured", line: "captured" });
});

test("not seen: before a source's first day, a day never published, a source the publication did not read, a week no night read", () => {
  expect(
    stateOf("2026-11-10", {
      sources: [source("line", { firstDay: "2026-10-30" })],
    })
  ).toEqual({ line: "not_seen: Life did not read it this day" });
  expect(
    stateOf("2026-10-01", {
      sources: [source("line", { firstDay: "2026-10-30" })],
    })
  ).toEqual({ line: "not_seen: before its first day, 2026-10-30" });
  // A day the history could not date: no units file.
  expect(
    stateOf("2026-11-10", { isPublished: false, sources: [source("imessage")] })
  ).toEqual({ imessage: "not_seen: Life read nothing this day" });
  // After the record began, a day no publication covers (the nights failed for a week): never "quiet".
  expect(stateOf("2026-11-16", { sources: [source("imessage")] })).toEqual({
    imessage: "not_seen: Life read nothing this day",
  });
});

test("unknown: a day before the record with no unit, and the pendant with nothing held", () => {
  expect(stateOf("2026-10-01", { sources: [source("imessage")] })).toEqual({
    imessage: "unknown: Life kept no record of what it read before 2026-11-13",
  });
  expect(
    stateOf("2026-11-10", {
      lines: [line("2026-11-07", "2026-11-13", ["lifelog"])],
      sources: [source("lifelog")],
    })
  ).toEqual({
    lifelog:
      "unknown: nothing held; Life cannot tell yet whether it was recording",
  });
  expect(
    stateOf("2026-11-10", { sources: [source("lifelog", { hasUnit: true })] })
  ).toEqual({ lifelog: "captured" });
});

test("today: a readable source is being captured, one that can't be read is not seen", () => {
  expect(
    stateOf("2026-11-20", {
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
        why: "nothing held; Life cannot tell yet whether it was recording",
      },
    ])
  ).toEqual([
    "",
    'Coverage (sources that capture on their own; "not seen" is not "quiet"):',
    "- Captured: iMessage, WhatsApp",
    "- Not seen: LINE (before its first day, 2026-10-30)",
    "- Unknown: Pendant (nothing held; Life cannot tell yet whether it was recording)",
  ]);
  expect(coveredLines([])).toEqual([]);
});
