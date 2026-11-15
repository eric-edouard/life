import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSettings, settings } from "../core/settings";
import { LEDGER } from "../memory/memory-files";
// biome-ignore lint/performance/noNamespaceImport: a test spies on its functions
import * as lifelog from "../sources/lifelog";
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

test("a new ask starts its agent's onAsk command once, a repeat never, another agent's never, and one that cannot start keeps the ask", async () => {
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
        Pulsar: { misheard: [], onAsk: ["/nowhere/pulsar"], wake: ["pulsar"] },
      },
    });
    said("call the bank", "Orbit");
    said("call the bank", "Orbit");
    said("water the plants", "Comet");
    said("book the dentist", "Orbit");
    said("feed the cat", "Pulsar");
    expect(asksFor("Pulsar").asks.map((a) => a.quote)).toEqual([
      "feed the cat",
    ]);
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

test("a new voice ask pushes 'heard' to his phone once; a repeat and a session ask don't; his words stay off it", () => {
  rmSync(LEDGER, { force: true });
  const push = spyOn(lifelog, "notifyPhone").mockResolvedValue(undefined);
  try {
    const heard = () =>
      ask(
        {
          at: "2026-10-15T09:00:00.000Z",
          quote: "hey orbit, pause it",
          ref: "test:wake",
        },
        { agent: "Orbit", confidence: "high" },
        "watch",
        "heard its wake"
      );
    heard();
    heard();
    said("call the bank", "Orbit");
    expect(push.mock.calls).toEqual([
      ["Orbit heard you", "Your ask reached it."],
    ]);
  } finally {
    push.mockRestore();
    rmSync(LEDGER, { force: true });
  }
});
