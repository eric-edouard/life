// The integrations (`docs/glossary.md`), read once and served to every surface that shows them: the status snapshot's
// source cards (`status/snapshot.ts`), `/status/integrations` for the host app, the connector's `read_integrations` for
// the phone, and `bun life bridge`. An integration is anything a user turns on that needs something of them
// (`records/integration.ts`); its terms live on the registry entry that already exists, and its state is
// `integrationHealthOf`'s. Nothing is stored here: every read is cached in process, and each holds what the snapshot
// reads hold under the same keys.

import { cached, safe } from "../core/cached";
import { clock, MIN } from "../core/clock";
import { systemZone, WINDOWS } from "../core/platform";
import { readAccessStatuses } from "../memory/access";
import { enabledSources, SOURCES } from "../memory/sources";
import { providerOf, readEngine, readEngineCheck } from "../models/llm";
import type { IntegrationTerms, Requirement } from "../records/integration";
import { copierOf } from "../sources/bridged";
import type { Descriptor, Newest } from "../sources/contract";
import { lifelogStatus, newestTurn } from "../sources/lifelog";
import { isBridgeAdded, isBridgeLinked, readBlock } from "../sources/matrix";
import { NETWORKS, type Network } from "../sources/networks";
import { needsAppKeys } from "./app-keys";
import { archiveFailing } from "./archive";
import {
  type IntegrationFacts,
  type IntegrationState,
  integrationHealthOf,
  type MetRequirement,
  PHONE_SILENT_MS,
  quietestAt,
  wokeAt,
} from "./integration-health";
import { readFullDiskAccess } from "./mac-access";
import { voiceStatus } from "./voice";

/** One network's bridge, as last checked: what it found, the command that fixes it, and whether it waits on his keys. */
export interface BridgeCheck {
  command?: string;
  needsKeys?: true;
  ok: boolean;
  text: string;
}

/**
 * Whether a network's bridge can read now (`bun life bridge`'s check): none needed for a network its own app is read
 * from, its keys first when it has app keys pending, then whichever app copies it (its bridge, or Beeper until it is
 * linked). The CLI's words go to `command`, alone.
 */
export async function readBridgeCheck(
  n: Network
): Promise<BridgeCheck | undefined> {
  // A network its own app is read from (WhatsApp) has a bridge only for sending: no bridge is no problem.
  if (n.readByItsApp && !isBridgeAdded(n.name)) {
    return;
  }
  const copier = n.readByItsApp ? "bridge" : copierOf(n.name);
  if (
    isBridgeAdded(n.name) &&
    !isBridgeLinked(n.name) &&
    (await needsAppKeys(n))
  ) {
    return {
      command: `bun life bridge link ${n.name}`,
      needsKeys: true,
      ok: false,
      text: "needs your app keys",
    };
  }
  if (copier === "beeper") {
    // Added but not linked yet: Beeper is still the one copying, so no gap opens; linking ends its session.
    return {
      ok: true,
      text: isBridgeAdded(n.name)
        ? "read from Beeper until you sign in from your phone"
        : "read from Beeper",
    };
  }
  if (copier === "beeper-closed") {
    return { ok: false, text: "Beeper is closed" };
  }
  if (!copier) {
    return {
      command: `bun life bridge add ${n.name}`,
      ok: false,
      text: "no bridge",
    };
  }
  const why = await readBlock(n.name);
  return why ? { ok: false, text: why } : { ok: true, text: "bridge running" };
}

/** Every network with something to check: its source is on, or its bridge is added. */
async function bridgeChecksNow() {
  const on = new Set(enabledSources().map((d) => d.name as string));
  const networks = NETWORKS.filter(
    (n) => on.has(n.name) || isBridgeAdded(n.name)
  );
  const found = await Promise.all(
    networks.map(async (n) => ({
      check: await readBridgeCheck(n),
      name: n.name,
    }))
  );
  return new Map(
    found.flatMap((f) =>
      f.check ? [[f.name, f.check] as [string, BridgeCheck]] : []
    )
  );
}

let bridges = new Map<string, BridgeCheck>();
let checkedAt = Number.NEGATIVE_INFINITY;
let check: Promise<void> | undefined;

/**
 * Every network's bridge check as last found: the status window reads every 3 s and a check may take 10 s, so a stale
 * one starts a fresh one in the background (every 15 s at most). Only a process's first read waits for one (10 s at
 * most, once), so a fresh process, like the tick's source alert, sees its bridges.
 */
export async function latestBridgeChecks(): Promise<Map<string, BridgeCheck>> {
  if (!check && performance.now() - checkedAt > 15_000) {
    // In a promise from the start: a check that throws at once never stops the snapshot or the next check.
    check = Promise.resolve()
      .then(() => bridgeChecksNow())
      .then((m) => {
        bridges = m;
      })
      .catch(() => undefined)
      .finally(() => {
        check = undefined;
        checkedAt = performance.now();
      });
  }
  if (checkedAt === Number.NEGATIVE_INFINITY) {
    await check;
  }
  return bridges;
}

/** Every source's newest item (`Descriptor.newest`), each read by its own module. */
const newestOf = async () =>
  new Map(
    await Promise.all(
      enabledSources().map(
        async (d) =>
          [
            d.name,
            await cached(
              `newest:${d.name}`,
              d.kind === "repo" ? 5 * MIN : 3000,
              () =>
                safe(
                  async (): Promise<Newest> =>
                    (await d.newest?.()) ?? { at: null }
                )
            ),
          ] as const
      )
    )
  );

/** What the integration facts read, each cached (the snapshot's reads hold the same, under the same cache keys). */
export async function readIntegrationReads(now: Date) {
  const [failingStores, bridgeChecks, life, newest, turn] = await Promise.all([
    cached("failing", 15_000, async () => new Map(await archiveFailing())),
    latestBridgeChecks(),
    cached("lifelog", 30_000, () => safe(lifelogStatus)),
    newestOf(),
    cached("turn", 3000, () => safe(newestTurn)),
  ]);
  return {
    bridges: bridgeChecks,
    failingStores,
    life,
    newest,
    now,
    t: now.getTime(),
    turn,
  };
}
export type IntegrationReads = Awaited<ReturnType<typeof readIntegrationReads>>;

/** What a source takes as an integration: its network's requirements first (its keys, its sign-in), else its own terms. */
export function requirementsOf(d: Descriptor): readonly Requirement[] {
  const n = NETWORKS.find((net) => net.name === d.name) as Network | undefined;
  if (!n) {
    return d.integration?.requirements ?? [];
  }
  return [
    ...n.integration.requirements,
    ...(n.appKeys
      ? [{ kind: "key" as const, name: n.name, opens: n.appKeys.opens }]
      : []),
    ...(n.readByItsApp
      ? []
      : [{ kind: "sign_in" as const, with: "network" as const }]),
  ];
}

/** Whether one of an integration's requirements is met now, by its own reader; a source checks nothing of itself. */
export function isDoneOf(
  r: Requirement,
  d: Descriptor,
  reads: IntegrationReads
): boolean {
  switch (r.kind) {
    case "permission":
      if (r.check === "full_disk_access") {
        return readFullDiskAccess() === "done";
      }
      // Free space is the step's own to judge (`accessStepsOf`); the helper is never spawned from here.
      return r.check === "disk_free"
        ? true
        : readAccessStatuses().statuses[r.check] === "done";
    case "sign_in":
      return r.with === "network"
        ? isBridgeLinked(d.name) || copierOf(d.name) === "beeper"
        : true;
    case "key":
      return reads.bridges.get(d.name)?.needsKeys !== true;
    case "device":
      return r.what === "phone"
        ? !d.missing?.()
        : !reads.life.ok || Boolean(reads.life.value.pendant);
    default:
      return true;
  }
}

/** An integration's facts, from its registry entry and the reads: the one builder the snapshot and the list share. */
export function integrationFactsOf(
  d: Descriptor,
  r: IntegrationReads
): IntegrationFacts {
  const base = {
    missing: d.missing?.(),
    on: enabledSources().includes(d),
    requirements: requirementsOf(d).map((x) => ({
      ...x,
      done: isDoneOf(x, d, r),
    })),
  };
  if (d.kind === "voice") {
    const pendant = pendantOf(r);
    // Silence counts from the start of his waking hours at the earliest (a night is not silence).
    const woke = wokeAt(r.now, systemZone())?.toISOString();
    const spokeAt = r.turn.ok ? (r.turn.value ?? null) : null;
    return {
      ...base,
      heardAt: spokeAt && woke && woke > spokeAt ? woke : spokeAt,
      kind: "pendant",
      now: r.t,
      phoneSilent:
        !!pendant?.knownAt &&
        r.t - Date.parse(pendant.knownAt) > PHONE_SILENT_MS,
      readable: r.turn.ok,
      recording: pendant?.recording === "recording",
      silentAfter: woke ? d.silentAfter : Number.POSITIVE_INFINITY,
    };
  }
  const read = r.newest.get(d.name) ?? {
    error: "not read",
    ok: false as const,
  };
  const bridge = r.bridges.get(d.name);
  const failing = r.failingStores.get(d.name);
  return {
    ...base,
    bridgeDown:
      bridge && !bridge.ok && !bridge.needsKeys ? bridge.text : undefined,
    imported: d.imported,
    kind: "source",
    now: r.t,
    read: read.ok
      ? { at: quietestAt(read.value), ok: true as const }
      : { error: read.error, ok: false as const },
    silentAfter: d.silentAfter,
    storeFailing: failing && String(failing.error ?? "its copy fails"),
  };
}

/** The Pendant, as lifelog last heard from the phone. */
const pendantOf = (r: IntegrationReads) =>
  r.life.ok ? r.life.value.pendant : undefined;

/** An integration as every surface shows it: its terms, its state now, and why when it waits on him or is broken. */
export interface Integration {
  group: "ai" | "voice" | "sources" | "messaging" | "phone";
  icon: string;
  id: string;
  name: string;
  privacy: string;
  requirements: MetRequirement[];
  state: IntegrationState;
  value: { answer: string; ask: string };
  why?: string;
}

/** One integration built from its terms and facts, its state decided once (`integrationHealthOf`). */
function integrationOf(o: {
  facts: IntegrationFacts;
  group: Integration["group"];
  icon: string;
  id: string;
  name: string;
  terms: IntegrationTerms;
}): Integration {
  const h = integrationHealthOf(o.facts);
  return {
    group: o.group,
    icon: o.icon,
    id: o.id,
    name: o.name,
    privacy: o.terms.privacy,
    requirements: [...o.facts.requirements],
    state: h.state,
    value: o.terms.value,
    ...(h.why ? { why: h.why } : {}),
  };
}

/** Voice's terms: it has no registry entry of its own. */
const VOICE_TERMS: IntegrationTerms = {
  privacy:
    "Speech is turned into text on this computer; a language outside its local set goes to ElevenLabs.",
  requirements: [],
  value: {
    answer: "You and Sam agreed he'd send the quote by Friday.",
    ask: "What did Sam and I agree on yesterday?",
  },
};

/** Whether a requirement the AI's terms name is met now, by the engine check. */
function isAiDone(
  r: Requirement,
  engineCheck: Awaited<ReturnType<typeof readEngineCheck>>
) {
  if (r.kind === "install") {
    return engineCheck.claudeFound;
  }
  if (r.kind === "sign_in") {
    return engineCheck.claudeSignedIn;
  }
  if (r.kind === "credits") {
    return engineCheck.credits === null || engineCheck.credits > 0;
  }
  return true;
}

/**
 * Every integration now, in the order a user meets them: the AI, voice, each source on this system, then each messaging
 * network. Served to the host app's setup window, the phone and `bun life bridge`.
 */
export async function integrationsNow(now = clock()): Promise<Integration[]> {
  const reads = await readIntegrationReads(now);
  const engine = readEngine();
  const { integration: aiTerms, label } = providerOf(engine);
  const engineCheck = await cached("engine check", MIN, () =>
    readEngineCheck(engine)
  );
  const { key } = engineCheck;
  // Its router's key first (the one he makes), then what its terms ask.
  const aiRequirements: MetRequirement[] = [
    ...(key
      ? [
          {
            done: key.set,
            kind: "key" as const,
            name: key.name,
            opens: key.opens,
          },
        ]
      : []),
    ...aiTerms.requirements.map((r) => ({
      ...r,
      done: isAiDone(r, engineCheck),
    })),
  ];
  const ai: Integration = integrationOf({
    facts: {
      host: engineCheck.host,
      kind: "ai",
      on: true,
      online: engineCheck.online,
      requirements: aiRequirements,
    },
    group: "ai",
    icon: engine,
    id: "ai",
    name: label,
    terms: aiTerms,
  });
  const v = await cached("voice", 15_000, () => voiceStatus());
  const voiceSource = SOURCES.find((d) => d.kind === "voice");
  const voice = integrationOf({
    facts: {
      answering: "answering" in v && v.answering === true,
      kind: "voice",
      line: v.line,
      on: !!voiceSource && enabledSources().includes(voiceSource),
      requirements: [],
    },
    group: "voice",
    icon: "voice",
    id: "voice",
    name: "Voice",
    terms: VOICE_TERMS,
  });
  // Where it runs comes from `macOnly`, never a second field.
  const here = (d: Descriptor) => !(d.macOnly && WINDOWS);
  const sources = SOURCES.filter((d) => d.integration && here(d)).map((d) =>
    integrationOf({
      facts: integrationFactsOf(d, reads),
      group: d.kind === "voice" ? "voice" : "sources",
      icon: d.name,
      id: d.kind === "voice" ? "pendant" : `source:${d.name}`,
      name: d.label,
      terms: d.integration as IntegrationTerms,
    })
  );
  // Each network is a source by name; its own entry holds its terms.
  const networks = NETWORKS.map((n) => ({
    d: SOURCES.find((s) => s.name === n.name),
    n,
  }))
    .filter(
      (x): x is { d: Descriptor; n: Network } => x.d !== undefined && here(x.d)
    )
    .map(({ d, n }) =>
      integrationOf({
        facts: integrationFactsOf(d, reads),
        group: "messaging",
        icon: n.name,
        id: `network:${n.name}`,
        name: n.label,
        terms: n.integration,
      })
    );
  return [ai, voice, ...sources, ...networks];
}
