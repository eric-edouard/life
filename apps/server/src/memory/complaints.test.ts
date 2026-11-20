import { expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import type { LedgerEntry } from "../records/ledger-entry";
import { COMPLAINTS, recordComplaints } from "./complaints";

// The complaint record: one row per complaint in ledger order, a torn last line dropped first, a bad earlier one shown,
// never rewritten. Made-up asks.

const complaint = (n: number, card: unknown): LedgerEntry => ({
  after: {
    agent: "desk",
    complaint: {
      card,
      cause: "c",
      isAsShown: true,
      ref: "r",
      report: false,
      shown: "s",
    },
  },
  at: `2026-11-20T09:0${n}:00.000Z`,
  id: `entry_00000000000${n}`,
  instruction: {
    at: "2026-11-20T09:00:00.000Z",
    quote: "Test: wrong",
    ref: `complaint:k${n}`,
  },
  kind: "ask",
  result: "ok",
  schemaVersion: 1,
  target: "agent",
  via: "connector",
  why: "test",
});
const asks = (): string[] =>
  readFileSync(COMPLAINTS, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).ask);

test("a row per complaint, once, in ledger order; a torn last line is dropped and its complaint's row written again; a bad earlier line throws", () => {
  rmSync(COMPLAINTS, { force: true });
  try {
    const one = complaint(1, { group: "ending" });
    const two = complaint(2, null);
    expect(recordComplaints([one])).toEqual([
      expect.objectContaining({
        kind: "ending",
        prompt: expect.stringMatching(/^memory-links\./),
        stage: "links",
      }),
    ]);
    appendFileSync(COMPLAINTS, '{"ask":"entry_0000000');
    expect(
      recordComplaints([one, two]).map((r) => [r.ask, r.kind, r.stage])
    ).toEqual([[two.id, "unknown", "unknown"]]);
    expect(recordComplaints([one, two])).toEqual([]);
    expect(asks()).toEqual([one.id, two.id]);
    rmSync(COMPLAINTS);
    appendFileSync(COMPLAINTS, "not json\n");
    expect(() => recordComplaints([one])).toThrow();
    expect(readFileSync(COMPLAINTS, "utf8")).toBe("not json\n");
  } finally {
    rmSync(COMPLAINTS, { force: true });
  }
});
