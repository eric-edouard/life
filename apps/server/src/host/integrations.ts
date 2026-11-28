// The integrations (`docs/glossary.md`), read once and served to every surface that shows them: the status snapshot's
// source cards (`status/snapshot.ts`), `/status/integrations` for the host app, the connector's `read_integrations` for
// the phone, and `bun life bridge`. An integration is anything a user turns on that needs something of them
// (`records/integration.ts`); its terms live on the registry entry that already exists, and its state is
// `integrationHealthOf`'s. Nothing is stored here: every read is cached in process, and each holds what the snapshot
// reads hold under the same keys.

import { cached, safe } from "../core/cached";
import { clock, daysBefore, MIN } from "../core/clock";
import type { Engine } from "../core/names";
import { systemZone } from "../core/platform";
import { settings } from "../core/settings";
import { readAccessStatuses } from "../memory/access";
import {
  appHere,
  enabledSources,
  readySources,
  SOURCES,
} from "../memory/sources";
import { localDate } from "../memory/zones";
import { providerOf, readEngine, readEngineCheck } from "../models/llm";
import type { IntegrationTerms, Requirement } from "../records/integration";
import type { Descriptor, Held, Newest } from "../sources/contract";
import { NETWORKS, type Network } from "../sources/networks";
import { newestTurn, readVoiceServerStatus } from "../sources/voice-server";
import { archiveFailing } from "./archive";
import {
  type BackfillState,
  backfillEstimateOf,
  backfillProgressOf,
  type HeldSource,
  readBackfillState,
} from "./backfill";
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
import { pausedImportsNow } from "./paused-imports";
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
  const [failingStores, bridgeChecks, life, newest, turn, mac] =
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
    ]);
  return {
    ...mac,
    bridges: bridgeChecks,
    failingStores,
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
      return (
        r.with !== "network" || reads.bridges.get(name)?.signedIn !== false
      );
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

/** A range "How far back" offers the AI's integration: its first day, its label, and what reading from it costs. */
export interface HowFarBackChoice {
  from: string;
  hours: number;
  label: string;
  tokens: number;
  usd?: number;
}

/** "How far back" in the AI's integration: the ranges to read his history from, and the day he picked. */
export interface HowFarBack {
  choices: HowFarBackChoice[];
  picked?: string;
}

/** An integration as every surface shows it: its terms, its state now, and why when it waits on him or is broken. */
export interface Integration {
  /** The backfill's line for a source: "reading 2019, about 3 hours left", or its paused import's. */
  backfill?: string;
  group: "ai" | "voice" | "sources" | "messaging" | "phone";
  /** What a source holds, as one line: "48,000 messages since 2014". */
  holds?: string;
  /** "How far back" the AI's integration offers: the ranges, and the one he picked. */
  howFarBack?: HowFarBack;
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
  backfill?: string;
  facts: IntegrationFacts;
  group: Integration["group"];
  holds?: string;
  howFarBack?: HowFarBack;
  icon: string;
  id: string;
  name: string;
  terms: IntegrationTerms;
}): Integration {
  const h = integrationHealthOf(o.facts);
  return {
    ...(o.backfill ? { backfill: o.backfill } : {}),
    group: o.group,
    ...(o.holds ? { holds: o.holds } : {}),
    ...(o.howFarBack ? { howFarBack: o.howFarBack } : {}),
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

/** A source's held, read once an hour: its "holds" line and "How far back" both use it. */
const heldOf = (d: Descriptor) =>
  cached(`held:${d.name}`, 60 * MIN, () => {
    try {
      return d.held?.() ?? null;
    } catch {
      return null;
    }
  });

const COUNT = new Intl.NumberFormat("en-US");

/** A noun's final s, dropped for a count of one. */
const FINAL_S = /s$/;

/** A source's held as one line: "48,000 messages since 2014", a count of one singular. Nothing when it holds nothing. */
export function holdsLineOf(held: Held | null) {
  if (!held?.count) {
    return;
  }
  const noun = held.count === 1 ? held.noun.replace(FINAL_S, "") : held.noun;
  const since = held.earliest ? ` since ${held.earliest.slice(0, 4)}` : "";
  return `${COUNT.format(held.count)} ${noun}${since}`;
}

/** A paused import's line, the same for every source: the caretaker offers its shape report. */
const PAUSED_LINE =
  "Import paused: Life is learning this format. It resumes by itself after an update";

/**
 * The backfill's line for a source: its paused import's first; else, while the backfill runs, the year it reads and the
 * hours left (the estimate's before a week is done); nothing when it is done. Pure: the state, the held and the day.
 */
export function backfillLineOf(o: {
  engine: Engine;
  from: string | undefined;
  held: Held | null;
  name: string;
  on: boolean;
  paused: boolean;
  state: BackfillState | undefined;
  today: string;
}) {
  if (o.paused) {
    return PAUSED_LINE;
  }
  if (!(o.on && o.from && o.held?.earliest && o.held.earliest < o.today)) {
    return;
  }
  const progress = backfillProgressOf(o.state, o.from, o.today);
  if (progress.hoursLeft === 0 && progress.doneWeeks === progress.totalWeeks) {
    return;
  }
  const hours =
    progress.hoursLeft > 0
      ? progress.hoursLeft
      : backfillEstimateOf(
          [{ held: o.held, name: o.name }],
          o.from,
          o.engine,
          o.today
        ).hours;
  const left = Math.max(1, Math.round(hours));
  return `reading ${progress.reading}, about ${left} ${left === 1 ? "hour" : "hours"} left`;
}

/**
 * "How far back" for the AI's integration: three ranges, each priced by `backfillEstimateOf` over every ready source's
 * held on the engine now; "Everything" starts at the earliest. Pure: the held, the engine and the pick come in.
 */
export function howFarBackOf(o: {
  engine: Engine;
  picked: string | undefined;
  sources: readonly HeldSource[];
  today: string;
}): HowFarBack {
  const earliest = o.sources.reduce<string | undefined>(
    (at, s) =>
      s.held?.earliest && (!at || s.held.earliest < at) ? s.held.earliest : at,
    undefined
  );
  const choices = [
    { from: daysBefore(o.today, 91), label: "The last 3 months" },
    { from: daysBefore(o.today, 365), label: "The last year" },
    { from: (earliest ?? o.today).slice(0, 10), label: "Everything" },
  ].map((c) => {
    const { hours, tokens, usd } = backfillEstimateOf(
      o.sources,
      c.from,
      o.engine,
      o.today
    );
    return { ...c, hours, tokens, ...(usd === undefined ? {} : { usd }) };
  });
  return { choices, ...(o.picked ? { picked: o.picked } : {}) };
}

/** Every ready source's held, read once an hour: "How far back" prices what each offers. */
const heldSourcesOf = async (): Promise<HeldSource[]> =>
  Promise.all(
    readySources().map(async (d) => ({
      held: await heldOf(d),
      name: d.name as string,
    }))
  );

/** A source's two lines, its held's and the backfill's: what its integration adds to its facts. */
const linesOf = (o: {
  engine: Engine;
  from: string | undefined;
  held: Held | null;
  name: string;
  on: boolean;
  paused: boolean;
  state: BackfillState | undefined;
  today: string;
}) => {
  const holds = holdsLineOf(o.held);
  const backfill = backfillLineOf(o);
  return { ...(backfill ? { backfill } : {}), ...(holds ? { holds } : {}) };
};

/**
 * Every integration now, in the order a user meets them: the AI, voice, each source on this system, then each messaging
 * network. Served to the host app's setup window, the phone and `bun life bridge`.
 */
export async function integrationsNow(now = clock()): Promise<Integration[]> {
  const engine = readEngine();
  const { integration: aiTerms, label } = providerOf(engine);
  const today = localDate(now.toISOString());
  const from = settings().backfillFrom;
  const [integrationReads, engineCheck, state, heldSources, paused] =
    await Promise.all([
      readIntegrationReads(now),
      cached("engine check", MIN, () => readEngineCheck(engine)),
      readBackfillState(),
      heldSourcesOf(),
      pausedImportsNow(),
    ]);
  const reads: IntegrationReads = { ...integrationReads, engine: engineCheck };
  const held = new Map(heldSources.map((s) => [s.name, s.held]));
  const pausedNames = new Set(paused.map((p) => p.source));
  const linesFor = (d: Descriptor) =>
    linesOf({
      engine,
      from,
      held: held.get(d.name as string) ?? null,
      name: d.name as string,
      on: reads.on.has(d.name),
      paused: pausedNames.has(d.name),
      state,
      today,
    });
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
    howFarBack: howFarBackOf({
      engine,
      picked: from,
      sources: heldSources,
      today,
    }),
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
  const sources = SOURCES.filter((d) => d.integration && appHere(d)).map((d) =>
    integrationOf({
      ...linesFor(d),
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
        ...linesFor(d),
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
