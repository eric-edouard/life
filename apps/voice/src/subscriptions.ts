// Account limits observed by the Mac's CLIs, never inferred from lifelog's token ledger.
import { z } from "@hono/zod-openapi";
import type { Db } from "@life/voice-db";
import { macEngines, subscriptionUsage } from "@life/voice-db/schema";
import { sql } from "drizzle-orm";

const Window = z.object({
  resetsAt: z.number().min(0).max(253_402_300_799),
  usedPercent: z.number().min(0).max(100),
});
// A window the Mac didn't observe is absent or null, unknown either way.
const SubscriptionReading = z.object({
  fiveHour: Window.nullable().default(null),
  observedAt: z.number().min(0).max(253_402_300_799),
  sevenDay: Window.nullable().default(null),
});
export const SubscriptionMessage = z.object({
  engine: z.enum(macEngines),
  reading: SubscriptionReading,
  type: z.literal("subscription.usage"),
});
export const Subscriptions = z
  .object({
    claude: SubscriptionReading.nullable(),
    codex: SubscriptionReading.nullable(),
  })
  .openapi("Subscriptions");

export function storeSubscriptionUsage(
  db: Db,
  message: z.infer<typeof SubscriptionMessage>
) {
  const { engine, reading } = message;
  // Reject a future clock: it would otherwise prevent every later valid observation from replacing this one.
  if (reading.observedAt > Date.now() / 1000 + 60) {
    return;
  }
  db.insert(subscriptionUsage)
    .values({ engine, reading })
    .onConflictDoUpdate({
      set: { reading },
      setWhere: sql`json_extract(${subscriptionUsage.reading}, '$.observedAt') < ${reading.observedAt}`,
      target: subscriptionUsage.engine,
    })
    .run();
}

export function subscriptions(db: Db): z.infer<typeof Subscriptions> {
  const result: z.infer<typeof Subscriptions> = { claude: null, codex: null };
  for (const row of db.select().from(subscriptionUsage).all()) {
    // A row that no longer parses is unknown: never a reason for the feed to fail.
    result[row.engine] =
      SubscriptionReading.safeParse(row.reading).data ?? null;
  }
  return result;
}
