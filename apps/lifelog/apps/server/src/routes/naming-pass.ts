import { createRoute, z } from "@hono/zod-openapi";
import type { NamingPass } from "../naming-pass";
import { ApiError, json, router } from "./common";

export function namingPassRoutes(pass: NamingPass) {
  return router().openapi(
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
