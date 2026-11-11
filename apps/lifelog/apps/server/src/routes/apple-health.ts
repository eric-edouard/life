import { createRoute, z } from "@hono/zod-openapi";
import { appleHealth } from "@lifelog/db/schema";
import { eq, gt } from "drizzle-orm";
import type { Services } from "../services";
import { json, router } from "./common";

const bounds = {
  endAt: z.iso.datetime({ offset: true }),
  id: z.string().min(1).max(200),
  startAt: z.iso.datetime({ offset: true }),
};
const SleepStage = z
  .enum(["in_bed", "awake", "core", "deep", "rem", "asleep"])
  .openapi("SleepStage");
const Measurement = z
  .discriminatedUnion("kind", [
    z
      .object({ ...bounds, kind: z.literal("sleep"), stage: SleepStage })
      .openapi("SleepMeasurement"),
    z
      .object({
        ...bounds,
        activity: z
          .string()
          .regex(/^[a-z]+(?:_[a-z]+)*$/)
          .max(80),
        kcal: z.number().nonnegative().optional(),
        kind: z.literal("workout"),
      })
      .openapi("WorkoutMeasurement"),
  ])
  .refine((m) => Date.parse(m.endAt) >= Date.parse(m.startAt), {
    message: "endAt precedes startAt",
  })
  .openapi("Measurement");

// A reader's cursor is the highest `seq` it holds.
const StoredMeasurement = Measurement.and(
  z.object({ seq: z.int().positive() })
).openapi("StoredMeasurement");

const measurementRowOf = (m: z.infer<typeof Measurement>) => ({
  activity: "activity" in m ? m.activity : null,
  endAt: new Date(m.endAt),
  id: m.id,
  kcal: "kcal" in m ? (m.kcal ?? null) : null,
  kind: m.kind,
  stage: "stage" in m ? m.stage : null,
  startAt: new Date(m.startAt),
});

export function appleHealthRoutes({ db }: Pick<Services, "db">) {
  return router()
    .openapi(
      createRoute({
        description:
          "Apple Health measurements, replaced only when their values changed. Device token only.",
        method: "post",
        path: "/apple-health",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  measurements: z.array(Measurement).max(1000),
                }),
              },
            },
            required: true,
          },
        },
        responses: {
          200: json(
            z.object({ stored: z.int().nonnegative() }),
            "New or changed measurements"
          ),
        },
      }),
      (c) => {
        const { measurements } = c.req.valid("json");
        const stored = db.transaction((tx) => {
          let count = 0;
          for (const m of measurements) {
            const row = measurementRowOf(m);
            const previous = tx
              .select()
              .from(appleHealth)
              .where(eq(appleHealth.id, m.id))
              .get();
            if (
              previous &&
              Object.entries(row).every(([key, value]) => {
                const held = previous[key as keyof typeof row];
                return value instanceof Date && held instanceof Date
                  ? value.getTime() === held.getTime()
                  : value === held;
              })
            ) {
              continue;
            }
            tx.delete(appleHealth).where(eq(appleHealth.id, m.id)).run();
            tx.insert(appleHealth).values(row).run();
            count += 1;
          }
          return count;
        });
        return c.json({ stored }, 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "Measurements after a cursor, in sequence order. Device token only; independent of /changes.",
        method: "get",
        path: "/apple-health",
        request: {
          query: z.object({
            after: z.coerce.number().int().nonnegative().default(0),
            limit: z.coerce.number().int().min(1).max(1000).default(1000),
          }),
        },
        responses: {
          200: json(
            z.object({ measurements: z.array(StoredMeasurement) }),
            "A page of measurements"
          ),
        },
      }),
      (c) => {
        const { after, limit } = c.req.valid("query");
        const rows = db
          .select()
          .from(appleHealth)
          .where(gt(appleHealth.seq, after))
          .orderBy(appleHealth.seq)
          .limit(limit)
          .all();
        const measurements = rows.map((row) => ({
          ...Measurement.parse({
            ...row,
            endAt: row.endAt.toISOString(),
            kcal: row.kcal ?? undefined,
            startAt: row.startAt.toISOString(),
          }),
          seq: row.seq,
        }));
        return c.json({ measurements }, 200);
      }
    );
}
