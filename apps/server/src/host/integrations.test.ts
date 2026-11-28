import { expect, test } from "bun:test";
import { Engine } from "../core/names";
import { SOURCES } from "../memory/sources";
import { providerOf } from "../models/llm";
import type { IntegrationTerms } from "../records/integration";
import { NETWORKS } from "../sources/networks";
import type { HeldSource } from "./backfill";
import { integrationHealthOf } from "./integration-health";
import {
  backfillLineOf,
  holdsLineOf,
  howFarBackOf,
  type IntegrationReads,
  integrationFactsOf,
  isDoneOf,
  requirementsOf,
} from "./integrations";

// The integration read's own rules, on made-up data: no network call, no read of this Mac.

/** Made-up reads: Telegram on, nothing read, nothing failing, no permission given, no bridge checked. */
const reads = (over: Partial<IntegrationReads> = {}): IntegrationReads => ({
  access: {},
  bridges: new Map(),
  failingStores: new Map(),
  fullDiskAccess: "missing",
  life: { error: "lifelog not set up", ok: false as const },
  missing: new Map(),
  newest: new Map(),
  now: new Date("2026-11-28T09:00:00.000Z"),
  on: new Set(["telegram"]),
  t: Date.parse("2026-11-28T09:00:00.000Z"),
  turn: { ok: true, value: null },
  ...over,
});

const sourceOf = (name: string) => {
  const d = SOURCES.find((s) => s.name === name);
  if (!d) {
    throw new Error(`no source ${name}`);
  }
  return d;
};

test("every source, network and engine that needs something of him carries its terms, each with a privacy line", () => {
  const terms: IntegrationTerms[] = [];
  // The networks are their own entries; Told Life and the agent's ledger need nothing of him.
  const needsNothing = new Set(["told-life", "agent"]);
  const networkNames = new Set<string>(NETWORKS.map((n) => n.name));
  for (const d of SOURCES) {
    if (needsNothing.has(d.name) || networkNames.has(d.name)) {
      expect(d.integration).toBeUndefined();
      continue;
    }
    if (d.integration) {
      terms.push(d.integration);
    } else {
      throw new Error(`${d.name} has no integration`);
    }
  }
  for (const n of NETWORKS) {
    terms.push(n.integration);
  }
  for (const engine of Engine.options) {
    terms.push(providerOf(engine).integration);
  }
  for (const t of terms) {
    expect(t.privacy.length).toBeGreaterThan(0);
    expect(t.value.ask.length).toBeGreaterThan(0);
    expect(t.value.answer.length).toBeGreaterThan(0);
  }
});

test("a network's requirements: its app keys first, then signing in from his phone", () => {
  const telegram = sourceOf("telegram");
  expect(requirementsOf(telegram)).toEqual([
    { kind: "key", name: "telegram", opens: "https://my.telegram.org" },
    { kind: "sign_in", with: "network" },
  ]);
  // WhatsApp's bridge only sends: its app is what Life reads, so it never asks him to sign in.
  expect(requirementsOf(sourceOf("whatsapp"))).toEqual([
    { check: "full_disk_access", kind: "permission" },
  ]);
  // A source with terms of its own keeps them.
  expect(requirementsOf(sourceOf("git"))).toEqual([]);
});

test("Telegram with no keys yet waits on him, with the key's words; signed in with its copier down, broken with the copier's", () => {
  const telegram = sourceOf("telegram");
  const bridge = (check: {
    needsKeys?: true;
    ok: boolean;
    signedIn?: boolean;
    text: string;
  }) =>
    reads({
      bridges: new Map([["telegram", check]]),
      newest: new Map([["telegram", { ok: true, value: { at: null } }]]),
    });
  const needingKeys = integrationFactsOf(
    telegram,
    bridge({
      needsKeys: true,
      ok: false,
      signedIn: false,
      text: "needs your app keys",
    })
  );
  expect(needingKeys.requirements).toEqual([
    {
      done: false,
      kind: "key",
      name: "telegram",
      opens: "https://my.telegram.org",
    },
    { done: false, kind: "sign_in", with: "network" },
  ]);
  expect(integrationHealthOf(needingKeys)).toMatchObject({
    state: "waiting_on_user",
    why: "Add your key from my.telegram.org.",
  });
  // Beeper holds his sign-in, so nothing waits on him: what is down is Beeper, in the bridge check's words.
  const beeperClosed = integrationFactsOf(
    telegram,
    bridge({ ok: false, signedIn: true, text: "Beeper is closed" })
  );
  expect(integrationHealthOf(beeperClosed)).toMatchObject({
    state: "broken",
    why: "Beeper is closed",
  });
  const [key] = requirementsOf(telegram);
  expect(key && isDoneOf(key, "telegram", reads())).toBe(true);
});

/** A made-up held, as a source's own read gives it. */
const held = (count: number, earliest: string, noun = "messages") => ({
  count,
  earliest,
  noun,
});

test("a source's holds line: its count in thousands, its noun, and the year its earliest came", () => {
  expect(holdsLineOf(held(48_000, "2014-05-02T10:00:00.000Z"))).toBe(
    "48,000 messages since 2014"
  );
  // A count of one drops the noun's final s.
  expect(holdsLineOf(held(1, "2024-01-02T00:00:00.000Z", "notes"))).toBe(
    "1 note since 2024"
  );
  expect(holdsLineOf(null)).toBeUndefined();
  expect(holdsLineOf(held(0, "2020-01-01T00:00:00.000Z"))).toBeUndefined();
});

/** A backfill line's shape: its year and its hours. */
const READING = /^reading \d{4}, about \d+ hours? left$/;

test("a source's backfill line: the year it reads and its hours left, the estimate's before a week is done; nothing once done", () => {
  const from = "2026-11-01";
  const today = "2026-11-28";
  const line = (state: Parameters<typeof backfillLineOf>[0]["state"]) =>
    backfillLineOf({
      engine: "claude",
      from,
      held: held(12_000, "2019-03-04T00:00:00.000Z"),
      name: "whatsapp",
      on: true,
      paused: false,
      state,
      today,
    });
  // No week done yet: the estimate's hours, on the year the backfill is reading.
  expect(line({ weeks: {} })).toMatch(READING);
  // A week done: its mean per week, for the weeks left.
  expect(line({ weeks: { "2026-11-01": 7200 } })).toMatch(READING);
  // Every week done and the matters and summaries read: nothing.
  expect(
    line({
      phaseB: "done",
      weeks: { "2026-11-01": 60, "2026-11-08": 60, "2026-11-15": 60 },
    })
  ).toBeUndefined();
  // The backfill off, or nothing held: no line.
  expect(
    backfillLineOf({
      engine: "claude",
      from: undefined,
      held: held(12_000, "2019-03-04T00:00:00.000Z"),
      name: "whatsapp",
      on: true,
      paused: false,
      state: { weeks: {} },
      today,
    })
  ).toBeUndefined();
  expect(
    backfillLineOf({
      engine: "claude",
      from,
      held: null,
      name: "whatsapp",
      on: true,
      paused: false,
      state: { weeks: {} },
      today,
    })
  ).toBeUndefined();
});

test("a paused import's line wins over the backfill's, and stands with the backfill off", () => {
  const paused = backfillLineOf({
    engine: "claude",
    from: "2026-11-01",
    held: held(12_000, "2019-03-04T00:00:00.000Z"),
    name: "whatsapp",
    on: true,
    paused: true,
    state: { weeks: {} },
    today: "2026-11-28",
  });
  expect(paused).toBe(
    "Import paused: Life is learning this format. It resumes by itself after an update"
  );
  expect(
    backfillLineOf({
      engine: "claude",
      from: undefined,
      held: null,
      name: "whatsapp",
      on: false,
      paused: true,
      state: undefined,
      today: "2026-11-28",
    })
  ).toBe(paused);
});

test("how far back: three ranges, priced on what the ready sources hold, the earliest as Everything, and the pick", () => {
  const sources: HeldSource[] = [
    { held: held(48_000, "2014-05-02T00:00:00.000Z"), name: "whatsapp" },
    { held: held(300, "2019-03-04T00:00:00.000Z", "photos"), name: "photos" },
    { held: null, name: "git" },
  ];
  const howFarBack = howFarBackOf({
    engine: "claude",
    picked: "2025-11-28",
    sources,
    today: "2026-11-28",
  });
  expect(howFarBack.choices.map((c) => [c.label, c.from])).toEqual([
    ["The last 3 months", "2026-08-29"],
    ["The last year", "2025-11-28"],
    ["Everything", "2014-05-02"],
  ]);
  for (const choice of howFarBack.choices) {
    expect(choice.hours).toBeGreaterThan(0);
    expect(choice.tokens).toBeGreaterThan(0);
    // A subscription engine: no dollars.
    expect(choice.usd).toBeUndefined();
  }
  expect(howFarBack.picked).toBe("2025-11-28");
  // Nothing picked: no picked field.
  expect(
    howFarBackOf({
      engine: "claude",
      picked: undefined,
      sources,
      today: "2026-11-28",
    }).picked
  ).toBeUndefined();
});
