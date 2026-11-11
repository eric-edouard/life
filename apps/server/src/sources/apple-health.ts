import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { DAY, HOUR, minutes } from "../core/clock";
import { openReadOnly } from "../core/sqlite";
import {
  QUANTITY_KINDS,
  type QuantityKind,
  type SourceEvent,
} from "../records/source";
import { isWithin } from "./contract";
import { call, WATCH } from "./lifelog";

const instant = z.iso.datetime({ offset: true });
const span = { endAt: instant, id: z.string(), startAt: instant };
/**
 * The measurements in lifelog's REST contract, never its database. lifelog checks what it stores (ids, activity
 * names, positive values); Life reads only what it uses, so a stricter reader can never stall the copy.
 */
export const Measurement = z.discriminatedUnion("kind", [
  z.object({
    ...span,
    kind: z.literal("sleep"),
    stage: z.enum(["in_bed", "awake", "core", "deep", "rem", "asleep"]),
  }),
  z.object({
    ...span,
    activity: z.string(),
    kcal: z.number().optional(),
    kind: z.literal("workout"),
  }),
  z.object({
    ...span,
    kind: z.enum(QUANTITY_KINDS),
    value: z.number(),
  }),
]);
export type Measurement = z.infer<typeof Measurement>;
export const AppleHealthPage = z.object({
  measurements: z.array(Measurement.and(z.object({ seq: z.int().positive() }))),
});

const copyPathOf = (dir: string) => join(dir, "apple-health.sqlite");

/** Fold each page into a rebuildable copy; its highest sequence is its cursor. */
export async function syncAppleHealth(dir = WATCH) {
  mkdirSync(dir, { recursive: true });
  const db = new Database(copyPathOf(dir));
  try {
    db.run("pragma journal_mode = wal");
    db.run("pragma busy_timeout = 5000");
    db.run(`create table if not exists measurements (
      id text primary key, seq integer not null unique, start_at text not null, end_at text not null, body text not null)`);
    db.run(
      "create index if not exists measurements_start on measurements(start_at)"
    );
    let cursor =
      db
        .query<{ seq: number }, []>(
          "select coalesce(max(seq), 0) as seq from measurements"
        )
        .get()?.seq ?? 0;
    const put = db.query(
      "insert or replace into measurements values (?, ?, ?, ?, ?)"
    );
    for (;;) {
      const page = AppleHealthPage.parse(
        // biome-ignore lint/performance/noAwaitInLoops: each page starts after the one just stored.
        await call(`/apple-health?after=${cursor}&limit=1000`)
      );
      const last = page.measurements.at(-1);
      if (!last) {
        return;
      }
      if (last.seq <= cursor) {
        throw new Error("Apple Health page did not advance its cursor");
      }
      db.transaction(() => {
        for (const m of page.measurements) {
          put.run(
            m.id,
            m.seq,
            new Date(m.startAt).toISOString(),
            new Date(m.endAt).toISOString(),
            JSON.stringify(m)
          );
        }
      })();
      cursor = last.seq;
    }
  } finally {
    db.close();
  }
}

const whole = (n: number) => Math.round(n).toLocaleString("en-US");
const QUANTITY_TEXT: Record<QuantityKind, (value: number) => string> = {
  heart_rate_variability: (v) => `HRV ${whole(v)} ms`,
  resting_heart_rate: (v) => `resting heart rate ${whole(v)} bpm`,
  steps: (v) => `${whole(v)} steps`,
  weight: (v) => `weight ${Math.round(v * 10) / 10} kg`,
};
/** A quantity as Life writes it, an event's or a day's total: whole numbers, weight to 0.1 kg. */
export const quantityText = (kind: QuantityKind, value: number) =>
  QUANTITY_TEXT[kind](value);

type Sleep = Extract<Measurement, { kind: "sleep" }>;

/** The union of intervals, so two devices never count the same time twice. */
function durationOf(segments: Sleep[]) {
  let end = Number.NEGATIVE_INFINITY;
  let ms = 0;
  for (const s of segments.toSorted(
    (a, b) => Date.parse(a.startAt) - Date.parse(b.startAt)
  )) {
    const until = Date.parse(s.endAt);
    ms += Math.max(0, until - Math.max(end, Date.parse(s.startAt)));
    end = Math.max(end, until);
  }
  return ms;
}

const eventOf = (
  id: string,
  at: string,
  text: string,
  measured?: SourceEvent["measured"]
): SourceEvent => ({
  at: new Date(at).toISOString(),
  chat: "apple-health",
  chatName: "Apple Health",
  fromMe: true,
  id: `apple-health:${id}`,
  ...(measured ? { measured } : {}),
  sender: "me",
  source: "apple-health",
  text,
});

/** Sleep segments less than an hour apart form one sleep, including naps; only asleep stages set its edges. */
export function nightsOf(segments: Sleep[]): SourceEvent[] {
  const groups: Sleep[][] = [];
  let end = Number.NEGATIVE_INFINITY;
  for (const s of segments.toSorted(
    (a, b) =>
      Date.parse(a.startAt) - Date.parse(b.startAt) || a.id.localeCompare(b.id)
  )) {
    if (Date.parse(s.startAt) - end >= HOUR || groups.length === 0) {
      groups.push([]);
    }
    groups.at(-1)?.push(s);
    end = Math.max(end, Date.parse(s.endAt));
  }
  return groups.flatMap((group) => {
    const asleep = group.filter(
      (s) => s.stage !== "in_bed" && s.stage !== "awake"
    );
    const [first] = asleep;
    if (!first) {
      return [];
    }
    const until = asleep.reduce(
      (latest, s) =>
        Date.parse(s.endAt) > Date.parse(latest) ? s.endAt : latest,
      first.endAt
    );
    const asleepMs = durationOf(asleep);
    const stages = (["deep", "rem", "core"] as const).flatMap((stage) => {
      const ms = durationOf(asleep.filter((s) => s.stage === stage));
      return ms > 0
        ? [`${stage === "rem" ? "REM" : stage} ${minutes(ms)}`]
        : [];
    });
    const awake = durationOf(group.filter((s) => s.stage === "awake"));
    return [
      eventOf(`${first.id}/sleep`, first.startAt, "fell asleep"),
      eventOf(
        `${first.id}/wake`,
        until,
        `woke: ${minutes(asleepMs)} asleep${stages.length ? ` (${stages.join(", ")})` : ""}${awake ? `, awake ${minutes(awake)}` : ""}`,
        { asleepMs, kind: "sleep" }
      ),
    ];
  });
}

/**
 * Sleeps are read whole before their events are bounded (midnight belongs to the unit path, never the source): a day
 * more on each side, so a sleep cut by the window is complete.
 */
export function readAppleHealth(
  since: Date,
  before?: Date,
  dir = WATCH
): SourceEvent[] {
  if (!existsSync(copyPathOf(dir))) {
    return [];
  }
  const db = openReadOnly(copyPathOf(dir));
  try {
    const rows = db
      .query<{ body: string }, [string, string | null]>(
        "select body from measurements where start_at >= ?1 and (?2 is null or start_at < ?2) order by start_at, id"
      )
      .all(
        new Date(since.getTime() - DAY).toISOString(),
        before ? new Date(before.getTime() + DAY).toISOString() : null
      );
    const measurements = rows.map((r) => Measurement.parse(JSON.parse(r.body)));
    return [
      ...nightsOf(measurements.filter((m): m is Sleep => m.kind === "sleep")),
      ...measurements.flatMap((m): SourceEvent[] => {
        if (m.kind === "sleep") {
          return [];
        }
        if (m.kind === "workout") {
          return [
            {
              ...eventOf(
                m.id,
                m.startAt,
                `${m.activity.replaceAll("_", " ")}${m.kcal === undefined ? "" : `, ${whole(m.kcal)} kcal`}`,
                {
                  activity: m.activity,
                  ...(m.kcal === undefined ? {} : { kcal: m.kcal }),
                  kind: "workout",
                }
              ),
              until: new Date(m.endAt).toISOString(),
            },
          ];
        }
        return [
          eventOf(m.id, m.startAt, quantityText(m.kind, m.value), {
            kind: m.kind,
            value: m.value,
          }),
        ];
      }),
    ]
      .filter(isWithin(since, before))
      .sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  } finally {
    db.close();
  }
}

function readEdge(dir: string, edge: "min" | "max") {
  if (!existsSync(copyPathOf(dir))) {
    return null;
  }
  const db = openReadOnly(copyPathOf(dir));
  try {
    return (
      db
        .query<{ at: string | null }, []>(
          `select ${edge}(start_at) as at from measurements`
        )
        .get()?.at ?? null
    );
  } finally {
    db.close();
  }
}

export const earliestAppleHealth = (dir = WATCH) => readEdge(dir, "min");
export const newestAppleHealth = (dir = WATCH) => ({
  at: readEdge(dir, "max"),
});
