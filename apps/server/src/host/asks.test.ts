import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { LEDGER } from "../memory/ledger";
import { ask, asksFor } from "./asks";

const said = (quote: string, agent: string) =>
  ask(
    { at: "2026-10-15T09:00:00.000Z", quote, ref: `test:${quote}` },
    { agent, confidence: "high" },
    "session",
    "test"
  );

test("an agent's asks page by its cursor: one at a time, another agent's skipped, a late one next", () => {
  rmSync(LEDGER, { force: true });
  try {
    said("call the bank", "Orbit");
    said("water the plants", "Comet");
    said("book the dentist", "Orbit");
    const one = asksFor("Orbit", undefined, 1);
    expect([one.asks.map((a) => a.quote), one.remaining]).toEqual([
      ["call the bank"],
      1,
    ]);
    const two = asksFor("Orbit", one.cursor, 1);
    expect([two.asks.map((a) => a.quote), two.remaining]).toEqual([
      ["book the dentist"],
      0,
    ]);
    said("pay the rent", "Orbit");
    expect(asksFor("Orbit", two.cursor).asks.map((a) => a.quote)).toEqual([
      "pay the rent",
    ]);
  } finally {
    rmSync(LEDGER, { force: true });
  }
});
