// The integrations (`docs/glossary.md`), read once and served to every surface that shows them: the status snapshot's
// source cards (`status/snapshot.ts`), `/status/integrations` for the host app, the connector's `read_integrations` for
// the phone, and `bun life bridge`. An integration is anything a user turns on that needs something of them
// (`records/integration.ts`); its terms live on the registry entry that already exists, and its state is
// `integrationHealthOf`'s. Nothing is stored here: every read is cached in process, and each holds what the snapshot
// reads hold under the same keys.

import { cached, safe } from "../core/cached";
import { clock, MIN } from "../core/clock";
import { readGoogleAccounts } from "../core/gog";
import { systemZone } from "../core/platform";
import { settings } from "../core/settings";
import { readAccessStatuses } from "../memory/access";
import { appHere, enabledSources, SOURCES } from "../memory/sources";
import { providerOf, readEngine, readEngineCheck } from "../models/llm";
import type { IntegrationTerms, Requirement } from "../records/integration";
import type { Descriptor, Newest } from "../sources/contract";
import { NETWORKS, type Network } from "../sources/networks";
import { newestTurn, readVoiceServerStatus } from "../sources/voice-server";
import { archiveFailing } from "./archive";
import { latestBridgeChecks } from "./bridge-check";
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
  const [failingStores, bridgeChecks, life, newest, turn, mac, google] =
    await Promise.all([
      cached("failing", 15_000, async () => new Map(await archiveFailing())),
      latestBridgeChecks(),
      cached("lifelog", 30_000, () => safe(readVoiceServerStatus)),
      newestOf(),
      cached("turn", 3000, () => safe(newestTurn)),
      // What each source still lacks and the Mac's permissions: each a disk read, so read once per window.
      cached("integration mac", 5000, () => ({
        access: readAccessStatuses().statuses,
        fullDiskAccess: readFullDiskAccess(),
        missing: new Map(SOURCES.map((d) => [d.name as string, d.missing?.()])),
        on: new Set(enabledSources().map((d) => d.name as string)),
      })),
      // Who is signed in with Google: gog's own list, read once per 5 minutes and no accounts when it fails.
      readGoogleAccounts(),
    ]);
  return {
    ...mac,
    bridges: bridgeChecks,
    failingStores,
    google,
    life,
    newest,
    now,
    t: now.getTime(),
    turn,
  };
}
export type IntegrationReads = Awaited<
  ReturnType<typeof readIntegrationReads>
> & {
  /** The AI's engine check, read only for the integration list. */
  engine?: Awaited<ReturnType<typeof readEngineCheck>>;
};

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

/** Whether one of the AI's requirements is met, by the engine check (unread: taken as met). */
function isEngineDoneOf(r: Requirement, e: IntegrationReads["engine"]) {
  if (!e) {
    return true;
  }
  switch (r.kind) {
    case "key":
      return e.key?.set !== false;
    case "install":
      return e.claudeFound;
    case "sign_in":
      return e.claudeSignedIn;
    case "credits":
      return e.credits === null || e.credits > 0;
    default:
      return true;
  }
}

/** Whether one of integration `name`'s requirements is met, from the reads alone. */
export function isDoneOf(
  r: Requirement,
  name: string,
  reads: IntegrationReads
): boolean {
  if (name === "ai") {
    return isEngineDoneOf(r, reads.engine);
  }
  switch (r.kind) {
    case "permission":
      // Free space is the step's own to judge (`accessStepsOf`).
      return (
        r.check === "disk_free" ||
        (r.check === "full_disk_access"
          ? reads.fullDiskAccess
          : reads.access[r.check]) === "done"
      );
    case "sign_in":
      // Google is done once one of his accounts still works; Claude's is the engine check's (`isEngineDoneOf`).
      return r.with === "google"
        ? reads.google.some((a) => a.valid)
        : r.with !== "network" || reads.bridges.get(name)?.signedIn !== false;
    case "key":
      return reads.bridges.get(name)?.needsKeys !== true;
    case "device":
      return r.what === "phone"
        ? !reads.missing.get(name)
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
    missing: r.missing.get(d.name),
    on: r.on.has(d.name),
    requirements: requirementsOf(d).map((x) => ({
      ...x,
      done: isDoneOf(x, d.name, r),
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

/** The Pendant, as the voice server last heard from the phone. */
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

/** Google's terms: his sign-in alone, under Life's OAuth client or one of his own (`connectGoogle`). */
const GOOGLE_TERMS: IntegrationTerms = {
  privacy:
    "Gmail, Google Calendar and Google Contacts are read by this computer with your own sign-in; the tokens stay on this computer; what Life reads goes to the AI you chose.",
  requirements: [{ kind: "sign_in", with: "google" }],
  value: {
    answer: "Ana sent the quote on Friday and asked for an answer by Tuesday.",
    ask: "What did Ana send me by mail this week?",
  },
};

/** Whether anything of Life's reads Google: the Gmail source, his appointments calendar, a Google past calendar or a Google to-do list. */
function isGoogleSet(on: ReadonlySet<string>) {
  const s = settings();
  return (
    on.has("gmail") ||
    !!s.appointmentsCalendar ||
    !!s.pastCalendar?.account ||
    s.todoList?.backend === "google"
  );
}

/**
 * Every integration now, in the order a user meets them: the AI, voice, Google, each source on this system, then each
 * messaging network. Served to the host app's setup window, the phone and `bun life bridge`.
 */
export async function integrationsNow(now = clock()): Promise<Integration[]> {
  const engine = readEngine();
  const { integration: aiTerms, label } = providerOf(engine);
  const [integrationReads, engineCheck] = await Promise.all([
    readIntegrationReads(now),
    cached("engine check", MIN, () => readEngineCheck(engine)),
  ]);
  const reads: IntegrationReads = { ...integrationReads, engine: engineCheck };
  const { key } = engineCheck;
  // Its router's key first (the one he makes), then what its terms ask.
  const aiRequirements: MetRequirement[] = [
    ...(key
      ? [{ kind: "key" as const, name: key.name, opens: key.opens }]
      : []),
    ...aiTerms.requirements,
  ].map((r) => ({ ...r, done: isDoneOf(r, "ai", reads) }));
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
      on: !!voiceSource && reads.on.has(voiceSource.name),
      requirements: [],
    },
    group: "voice",
    icon: "voice",
    id: "voice",
    name: "Voice",
    terms: VOICE_TERMS,
  });
  const google = integrationOf({
    facts: {
      kind: "google",
      on: isGoogleSet(reads.on),
      requirements: GOOGLE_TERMS.requirements.map((x) => ({
        ...x,
        done: isDoneOf(x, "google", reads),
      })),
    },
    group: "sources",
    icon: "google",
    id: "google",
    name: "Google",
    terms: GOOGLE_TERMS,
  });
  const sources = SOURCES.filter((d) => d.integration && appHere(d)).map((d) =>
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
      (x): x is { d: Descriptor; n: Network } =>
        x.d !== undefined && appHere(x.d)
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
  return [ai, voice, google, ...sources, ...networks];
}
