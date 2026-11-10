import { createRoute, z } from "@hono/zod-openapi";
import { storeNamingGate } from "../naming-rollout";
import type { Services } from "../services";
import { ApiError, json, router } from "./common";

export function namingPassRoutes({
  db,
  naming: pass,
}: Pick<Services, "db" | "naming">) {
  return router()
    .openapi(
      createRoute({
        description:
          "Install an offline passing naming evaluation. The server remains the only database writer; this runs no measurement or model call.",
        method: "post",
        path: "/naming-gate",
        request: {
          body: json(
            z.strictObject({ model: z.string().min(1), receipt: z.unknown() }),
            "Measured model and passing report"
          ),
        },
        responses: {
          200: json(
            z.object({ installed: z.literal(true) }),
            "Gate receipt installed"
          ),
          400: json(ApiError, "Insufficient or mismatched report"),
        },
      }),
      (c) => {
        const { model, receipt } = c.req.valid("json");
        if (!storeNamingGate(db, receipt, model)) {
          return c.json(
            {
              error: "invalid_state" as const,
              message: "Insufficient or mismatched naming gate",
            },
            400
          );
        }
        return c.json({ installed: true as const }, 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "Advance at most one persisted naming work item on the selected Codex subscription. Evaluation and pilot store readings only; archive writes require separate explicit authorization. Missing/non-Codex engine is off. Summary work has priority.",
        method: "post",
        path: "/naming-pass",
        request: {
          body: json(
            z.strictObject({
              archiveAuthorized: z.boolean().optional(),
              engine: z.string().optional(),
              mode: z.enum(["evaluation", "pilot", "archive", "arrivals"]),
            }),
            "Selected backfill engine and pass mode"
          ),
        },
        responses: {
          202: json(z.object({ status: z.string() }), "Current queue state"),
          400: json(ApiError, "Invalid request"),
        },
      }),
      (c) => c.json({ status: pass.start(c.req.valid("json")) }, 202)
    );
}
