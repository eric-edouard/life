import { expect, test } from "bun:test";
import { Engine } from "../core/names";
import { SOURCES } from "../memory/sources";
import { providerOf } from "../models/llm";
import type { IntegrationTerms } from "../records/integration";
import { NETWORKS } from "../sources/networks";
import { integrationHealthOf } from "./integration-health";
import {
  aiFactsOf,
  type IntegrationReads,
  integrationFactsOf,
  isDoneOf,
  requirementsOf,
} from "./integrations";

// The integration read's own rules, on made-up data: no network call, no read of this Mac.

/** Made-up reads: Telegram on, nothing read, nothing failing, no permission given, no bridge checked. */
const reads = (over: Partial<IntegrationReads> = {}): IntegrationReads => ({
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

test("the Pendant before the phone's first heartbeat is not red: the voice server answers, it just has none yet", () => {
  const facts = integrationFactsOf(
    sourceOf("voice"),
    reads({
      life: {
        ok: true,
        value: { pendant: null } as unknown as Extract<
          IntegrationReads["life"],
          { ok: true }
        >["value"],
      },
      on: new Set(["voice"]),
    })
  );
  expect(integrationHealthOf(facts).tone).not.toBe("bad");
});

test("the AI on OpenRouter alone is working: allmodels' key is an optional fallback, listed but never waited on", () => {
  const facts = aiFactsOf(
    {
      claudeFound: true,
      claudeSignedIn: true,
      credits: 5,
      host: "openrouter.ai",
      keys: [
        {
          name: "OPENROUTER_API_KEY",
          opens: "https://openrouter.ai",
          set: true,
        },
        {
          name: "ALLMODELS_API_KEY",
          opens: "https://allmodels.io",
          optional: true,
          set: false,
        },
      ],
      online: true,
    },
    providerOf("openrouter").integration
  );
  expect(facts.requirements).toContainEqual(
    expect.objectContaining({
      done: false,
      name: "ALLMODELS_API_KEY",
      optional: true,
    })
  );
  expect(integrationHealthOf(facts).state).toBe("working");
});
