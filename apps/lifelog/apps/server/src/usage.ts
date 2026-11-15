// What was spent, per day in the owner's zone, from our own ledgers: transcription jobs
// and intelligence runs. Every figure is our estimate at list prices;
// ElevenLabs' own report is added beside it when it answers, never mixed in.

import { clock } from "@life/server/src/core/clock";
import type { Db } from "@lifelog/db";
import {
  type IntelligenceProvider,
  intelligenceProviders,
  intelligenceRuns,
  transcriptionJobs as jobs,
  quickTranscriptions as quick,
} from "@lifelog/db/schema";
import { and, gte, ne, notInArray } from "drizzle-orm";
import {
  type Config,
  ownerClock,
  ownerTimeZone,
  SCRIBE_USD_PER_HOUR,
} from "./config";
import { workspaceSpeechToText } from "./elevenlabs";
import { zonedInstant } from "./location";

const DAYS = 30;
// Enough history for the last 30 days and the whole current month, whatever the date.
const LOOKBACK_MS = 32 * 86_400_000;

interface Period {
  intelligence: {
    byProvider: Record<IntelligenceProvider, number>;
    // Historical paid-API runs whose model had no known price: spent, but not in usd. Runs on
    // the Mac cost 0.
    unpricedRuns: number;
    usd: number;
  };
  totalUsd: number;
  transcription: {
    // Billable hours at the base rate (keyterms included).
    hours: number;
    usd: number;
  };
}

const emptyPeriod = (): Period => ({
  intelligence: {
    byProvider: Object.fromEntries(
      intelligenceProviders.map((p) => [p, 0])
    ) as Record<IntelligenceProvider, number>,
    unpricedRuns: 0,
    usd: 0,
  },
  totalUsd: 0,
  transcription: { hours: 0, usd: 0 },
});

function add(into: Period, from: Period) {
  into.transcription.hours += from.transcription.hours;
  into.transcription.usd += from.transcription.usd;
  for (const p of intelligenceProviders) {
    into.intelligence.byProvider[p] += from.intelligence.byProvider[p];
  }
  into.intelligence.unpricedRuns += from.intelligence.unpricedRuns;
  into.intelligence.usd += from.intelligence.usd;
  into.totalUsd += from.totalUsd;
}

// "YYYY-MM-DD" minus n calendar days.
const minusDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000)
    .toISOString()
    .slice(0, 10);

// Each owner's day's spending, from the rows of the lookback.
function spendingByDay(
  transcription: { at: Date; seconds: number }[],
  intelligence: {
    at: Date;
    provider: keyof Period["intelligence"]["byProvider"];
    usd: number | null;
  }[]
) {
  const byDay = new Map<string, Period>();
  const period = (at: Date) => {
    const day = ownerClock(at).date;
    const p = byDay.get(day) ?? emptyPeriod();
    byDay.set(day, p);
    return p;
  };
  for (const row of transcription) {
    period(row.at).transcription.hours += row.seconds / 3600;
  }
  for (const row of intelligence) {
    const p = period(row.at);
    p.intelligence.byProvider[row.provider] += row.usd ?? 0;
    p.intelligence.usd += row.usd ?? 0;
    p.intelligence.unpricedRuns += row.usd === null ? 1 : 0;
  }
  for (const p of byDay.values()) {
    p.transcription.usd = p.transcription.hours * SCRIBE_USD_PER_HOUR;
    p.totalUsd = p.transcription.usd + p.intelligence.usd;
  }
  return byDay;
}

export async function usageSummary(db: Db, config: Config, now = clock()) {
  const since = new Date(now.getTime() - LOOKBACK_MS);
  const today = ownerClock(now).date;
  const monthStart = zonedInstant(
    `${today.slice(0, 8)}01T00:00`,
    ownerTimeZone()
  );

  const transcription = db
    .select({ at: jobs.admittedAt, seconds: jobs.billableSeconds })
    .from(jobs)
    // Everything admitted except what never reached ElevenLabs.
    .where(and(ne(jobs.state, "failed"), gte(jobs.admittedAt, since)))
    .all();
  const quickRows = db
    .select({ at: quick.createdAt, seconds: quick.billableSeconds })
    .from(quick)
    .where(gte(quick.createdAt, since))
    .all();
  const intelligence = db
    .select({
      at: intelligenceRuns.createdAt,
      provider: intelligenceRuns.provider,
      usd: intelligenceRuns.costUsd,
    })
    .from(intelligenceRuns)
    // A running or waiting run has spent nothing recorded yet.
    .where(
      and(
        notInArray(intelligenceRuns.state, ["running", "waiting"]),
        gte(intelligenceRuns.createdAt, since)
      )
    )
    .all();
  const elevenLabs = await workspaceSpeechToText(config, monthStart, now);

  const byDay = spendingByDay([...transcription, ...quickRows], intelligence);
  const days = Array.from({ length: DAYS }, (_, i) => {
    const date = minusDays(today, DAYS - 1 - i);
    return { date, ...(byDay.get(date) ?? emptyPeriod()) };
  });
  const last30Days = emptyPeriod();
  for (const day of days) {
    add(last30Days, day);
  }
  const thisMonth = emptyPeriod();
  const monthDay = today.slice(0, 8);
  for (const [date, p] of byDay) {
    if (date.startsWith(monthDay) && date <= today) {
      add(thisMonth, p);
    }
  }

  return {
    days,
    elevenLabsThisMonth: elevenLabs,
    last30Days,
    monthStart: monthStart.toISOString(),
    thisMonth,
    timeZone: ownerTimeZone(),
    today: byDay.get(today) ?? emptyPeriod(),
  };
}
