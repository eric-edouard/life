import { expect, test } from "bun:test";
import { appendFileSync, readFileSync, rmSync } from "node:fs";
import type { LedgerEntry } from "../records/ledger-entry";
import { COMPLAINTS, recordComplaints, stageOf } from "./complaint-record";

// The complaint record: one row per complaint in ledger order, a torn last line dropped first, a bad row (earlier, or
// whole and last) shown, never rewritten. Made-up asks.

const LINKS_PROMPT = /^memory-links\./;
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
      ...stageOf(card),
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

test("a row per complaint, once, in ledger order; a torn last line is dropped and its complaint's row written again; a bad row, whole last line or earlier, throws and stays", () => {
  rmSync(COMPLAINTS, { force: true });
  try {
    const one = complaint(1, { group: "ending" });
    const two = complaint(2, null);
    expect(recordComplaints([one])).toEqual([
      expect.objectContaining({
        kind: "ending",
        prompt: expect.stringMatching(LINKS_PROMPT),
        stage: "links",
      }),
    ]);
    appendFileSync(COMPLAINTS, '{"ask":"entry_0000000');
    expect(
      recordComplaints([one, two]).map((r) => [r.ask, r.kind, r.stage])
    ).toEqual([[two.id, "unknown", "unknown"]]);
    expect(recordComplaints([one, two])).toEqual([]);
    expect(asks()).toEqual([one.id, two.id]);
    // A whole row cut before its newline is kept, not written twice.
    const whole = readFileSync(COMPLAINTS, "utf8").trimEnd();
    rmSync(COMPLAINTS);
    appendFileSync(COMPLAINTS, whole);
    expect(recordComplaints([one, two])).toEqual([]);
    expect(asks()).toEqual([one.id, two.id]);
    // A whole last line that is not a row (another version) is kept, its error shown.
    const other = JSON.stringify({
      ...JSON.parse(whole.split("\n")[0] ?? ""),
      schemaVersion: 2,
    });
    rmSync(COMPLAINTS);
    appendFileSync(COMPLAINTS, other);
    expect(() => recordComplaints([one])).toThrow("schemaVersion");
    expect(readFileSync(COMPLAINTS, "utf8")).toBe(other);
    rmSync(COMPLAINTS);
    appendFileSync(COMPLAINTS, "not json\n");
    expect(() => recordComplaints([one])).toThrow();
    expect(readFileSync(COMPLAINTS, "utf8")).toBe("not json\n");
  } finally {
    rmSync(COMPLAINTS, { force: true });
  }
});
