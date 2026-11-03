import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSettings, settings } from "../core/settings";
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

test("a new ask starts its agent's onAsk command once, a repeat never, another agent's never", async () => {
  rmSync(LEDGER, { force: true });
  const before = settings().agents;
  const started = join(mkdtempSync(join(tmpdir(), "on-ask-")), "started");
  try {
    setSettings({
      agents: {
        Comet: { misheard: [], wake: ["comet"] },
        Orbit: {
          misheard: [],
          onAsk: ["sh", "-c", `echo x >> ${started}`],
          wake: ["orbit"],
        },
      },
    });
    said("call the bank", "Orbit");
    said("call the bank", "Orbit");
    said("water the plants", "Comet");
    said("book the dentist", "Orbit");
    const lines = () =>
      existsSync(started)
        ? readFileSync(started, "utf8").trim().split("\n").length
        : 0;
    // Each start is detached: wait for the two to land (a second up), then a little for any wrong third.
    const landed = async (tries: number): Promise<void> => {
      if (lines() < 2 && tries > 0) {
        await Bun.sleep(20);
        return landed(tries - 1);
      }
    };
    await landed(50);
    await Bun.sleep(100);
    expect(lines()).toBe(2);
  } finally {
    setSettings({ agents: before ?? null });
    rmSync(LEDGER, { force: true });
  }
});
