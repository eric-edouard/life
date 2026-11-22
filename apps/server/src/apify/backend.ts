// Apify (apify.com), the one place Life calls it, with his token (`APIFY_TOKEN`, the Keychain item his Mac app writes):
// the store's actors with their prices at his plan's tier (free), a capped run started on his yes to a card's `apify`
// need, and a run read back. Prices are Apify's own, per actor: a run's cost is what Apify bills (`usageTotalUsd`),
// never a price of Life's.

const API = "https://api.apify.com/v2";
export const APIFY_KEY_ENV = "APIFY_TOKEN";

/** His token, or none: Apify is a skill of his agents only while he connected it. */
export const apifyToken = () => process.env[APIFY_KEY_ENV] || undefined;

/** The most of a run's items read back, and of an actor search's answers. */
const ITEMS = 50;
const FOUND = 8;

/** Apify's JSON answer (`data`) to `path`; a refusal throws with its status and Apify's own words. */
async function askApify<T>(
  path: string,
  init: RequestInit & { token?: string } = {}
): Promise<T> {
  const { token = apifyToken(), ...rest } = init;
  const r = await fetch(`${API}${path}`, {
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: rest.signal ?? AbortSignal.timeout(30_000),
  });
  const body = (await r.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!(r.ok && body.data)) {
    throw new Error(`Apify ${r.status}: ${body.error?.message ?? "no answer"}`);
  }
  return body.data;
}

interface PricingInfo {
  minimalMaxTotalChargeUsd?: number | null;
  pricingModel?: string;
  pricingPerEvent?: {
    actorChargeEvents?: Record<
      string,
      {
        eventPriceUsd?: number;
        eventTieredPricingUsd?: Record<string, { tieredEventPriceUsd: number }>;
        eventTitle?: string;
      }
    >;
  };
}

/** An actor's price at `tier`: what one event or result costs, and whether a run of it can be capped in dollars. */
export interface ActorPrice {
  /** A run of it can be held under a dollar cap (paid per event): only such an actor is ever run. */
  capped: boolean;
  /** The least cap Apify takes for a run of it, in dollars. */
  minimalCapUsd: number | null;
  model: string;
  /** Each charged event and its dollars at his tier. */
  prices: { name: string; title: string; usd: number }[];
}

// ponytail: per event only. The store's other models today are FREE (platform usage, no dollar cap) and a monthly
// rent; per-result actors, once common, are gone from it (22 Nov 2026). Add `maxItems` if they come back.
const PER_EVENT = "PAY_PER_EVENT";

/** `info`'s prices at `tier` (his plan's, `FREE` when unknown). */
export function actorPriceOf(
  info: PricingInfo | undefined,
  tier: string
): ActorPrice {
  const model = info?.pricingModel ?? "PLATFORM_USAGE";
  const events = Object.entries(
    info?.pricingPerEvent?.actorChargeEvents ?? {}
  ).flatMap(([name, e]) => {
    const usd =
      e.eventTieredPricingUsd?.[tier]?.tieredEventPriceUsd ??
      e.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd ??
      e.eventPriceUsd;
    return usd === undefined
      ? []
      : [{ name, title: e.eventTitle ?? name, usd }];
  });
  return {
    capped: model === PER_EVENT,
    minimalCapUsd: info?.minimalMaxTotalChargeUsd ?? null,
    model,
    prices: events,
  };
}

/** His plan's tier (`BRONZE`…), which sets each actor's prices. */
const readTier = async () =>
  (await askApify<{ plan?: { tier?: string } }>("/users/me")).plan?.tier ??
  "FREE";

/** An actor of the store as an agent weighs it: who made it, how used, how rated, and its prices at his tier. */
export interface FoundActor extends ActorPrice {
  description: string;
  /** `username/name`: what a card's `apify` need names. */
  id: string;
  rating: number | null;
  title: string;
  users30Days: number | null;
}

/** The store's actors for `query`, priced at his tier. */
export async function findActors(query: string): Promise<FoundActor[]> {
  const [tier, found] = await Promise.all([
    readTier(),
    askApify<{
      items: {
        currentPricingInfo?: PricingInfo;
        description?: string;
        name: string;
        stats?: { actorReviewRating?: number; totalUsers30Days?: number };
        title: string;
        username: string;
      }[];
    }>(`/store?search=${encodeURIComponent(query)}&limit=${FOUND}`),
  ]);
  return found.items.map((a) => ({
    description: (a.description ?? "").slice(0, 300),
    id: `${a.username}/${a.name}`,
    rating: a.stats?.actorReviewRating ?? null,
    title: a.title,
    users30Days: a.stats?.totalUsers30Days ?? null,
    ...actorPriceOf(a.currentPricingInfo, tier),
  }));
}

/** The run's dollar cap for `maxUsd`, which Apify holds it under (`maxTotalChargeUsd`); throws for an actor it can't cap. */
export function capOf(price: ActorPrice, maxUsd: number) {
  if (!price.capped) {
    throw new Error(
      `${price.model} actors can't be held under a dollar cap: only pay-per-event actors run`
    );
  }
  if (price.minimalCapUsd !== null && maxUsd < price.minimalCapUsd) {
    throw new Error(
      `this actor takes a cap of at least $${price.minimalCapUsd}`
    );
  }
  return maxUsd;
}

/** Starts `actor` on `input` held under `maxUsd` (`capOf`); returns the run's id at once, never waiting for it. */
export async function startRun(
  actor: string,
  input: unknown,
  maxUsd: number
): Promise<string> {
  const path = `/acts/${encodeURIComponent(actor.replace("/", "~"))}`;
  const [tier, act] = await Promise.all([
    readTier(),
    askApify<{ pricingInfos?: PricingInfo[] }>(path),
  ]);
  const cap = capOf(actorPriceOf(act.pricingInfos?.at(-1), tier), maxUsd);
  const run = await askApify<{ id: string }>(
    `${path}/runs?maxTotalChargeUsd=${cap}`,
    {
      body: JSON.stringify(input ?? {}),
      method: "POST",
    }
  );
  return run.id;
}

/** A run as Apify holds it: its status, its cost so far (`usageTotalUsd`, settled a minute or so after it ends) and its first items. */
export async function readRun(runId: string, withItems = true) {
  const run = await askApify<{
    defaultDatasetId: string;
    finishedAt: string | null;
    status: string;
    usageTotalUsd?: number;
  }>(`/actor-runs/${encodeURIComponent(runId)}`);
  const items =
    withItems && run.status === "SUCCEEDED"
      ? await fetch(
          `${API}/datasets/${run.defaultDatasetId}/items?clean=1&limit=${ITEMS}`,
          {
            headers: { Authorization: `Bearer ${apifyToken() ?? ""}` },
            signal: AbortSignal.timeout(30_000),
          }
        ).then((r) => r.json() as Promise<unknown[]>)
      : [];
  return {
    finishedAt: run.finishedAt,
    items,
    status: run.status,
    usd: run.usageTotalUsd ?? null,
  };
}
