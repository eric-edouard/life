import { createRoute, z } from "@hono/zod-openapi";
import {
  LifePeopleInput,
  replaceLifePeople,
  SnapshotConflict,
} from "../life-people";
import type { Services } from "../services";
import { ApiError, json, router } from "./common";

export function lifePeopleRoutes({ db }: Pick<Services, "db">) {
  return router().openapi(
    createRoute({
      method: "put",
      path: "/life/people",
      request: {
        body: {
          content: { "application/json": { schema: LifePeopleInput } },
          required: true,
        },
      },
      responses: {
        200: json(
          z.object({ changed: z.boolean(), revision: z.int() }),
          "Complete snapshot accepted"
        ),
        400: json(ApiError, "Invalid or incomplete snapshot"),
        409: json(ApiError, "Revision or identity link conflict"),
      },
    }),
    (c) => {
      try {
        return c.json(replaceLifePeople(db, c.req.valid("json")), 200);
      } catch (error) {
        if (error instanceof SnapshotConflict) {
          return c.json(
            { error: "invalid_state" as const, message: error.message },
            409
          );
        }
        throw error;
      }
    }
  );
}
