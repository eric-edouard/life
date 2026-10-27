// Places: the phone's location history, with Apple's place names, and the stays a reader reads.
import { createRoute, z } from "@hono/zod-openapi";
import { storeHistory, visitsTo, whereVisits } from "../location";
import type { Services } from "../services";
import { ApiError, json, router } from "./common";

const Latitude = z.number().min(-90).max(90);
const Longitude = z.number().min(-180).max(180);
const LocationFix = z
  .object({
    accuracyM: z.number().nonnegative(),
    latitude: Latitude,
    longitude: Longitude,
    observedAt: z.iso.datetime(),
    placeName: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "Apple's name for where it was taken (a street or a district, and the city)"
      ),
  })
  .openapi("LocationFix");

// A visit iOS reported: arrival and departure, each null when iOS didn't see it.
const LocationVisit = z
  .object({
    accuracyM: z.number().nonnegative(),
    arrivedAt: z.iso.datetime().nullable(),
    departedAt: z.iso.datetime().nullable(),
    latitude: Latitude,
    longitude: Longitude,
  })
  .refine((v) => v.arrivedAt !== null || v.departedAt !== null, {
    message: "a visit needs an arrival or a departure",
  })
  .openapi("LocationVisit");

// A stay: arrival to departure, iOS's own or the first and last fix there.
const Visit = z
  .object({
    arrivedAt: z.iso.datetime(),
    latitude: Latitude,
    leftAt: z.iso.datetime(),
    longitude: Longitude,
    place: z
      .string()
      .optional()
      .describe("The phone's name for the place, when it has one"),
  })
  .openapi("Visit");
const Instant = z.iso.datetime({ offset: true });

export function placeRoutes({ db }: Pick<Services, "db">) {
  return router()
    .openapi(
      createRoute({
        description:
          "The phone's whole location history: every fix it took, with Apple's place name when it " +
          "has one, and every visit iOS reported. The server names conversations' places from it. " +
          "Idempotent: one fix per instant (a name sent later fills one stored without); a visit " +
          "is keyed by its arrival (its departure when iOS didn't see it arrive) and replaced when " +
          "sent again with its departure.",
        method: "post",
        path: "/location-history",
        request: {
          body: {
            content: {
              "application/json": {
                schema: z.object({
                  fixes: z.array(LocationFix).max(1000).default([]),
                  visits: z.array(LocationVisit).max(1000).default([]),
                }),
              },
            },
            required: true,
          },
        },
        responses: {
          200: json(
            z.object({ fixes: z.int(), visits: z.int() }),
            "Rows written; a fix already stored as it is counts 0"
          ),
        },
      }),
      (c) => c.json(storeHistory(db, c.req.valid("json")), 200)
    )
    .openapi(
      createRoute({
        description:
          "Where the owner was at an instant: the stay around it, or the nearest point within " +
          "30 minutes, else nothing. A day's stays: `GET /visits` with its `from` and `to`.",
        method: "get",
        path: "/where",
        request: {
          query: z.object({
            at: Instant,
          }),
        },
        responses: { 200: json(z.array(Visit), "Stays") },
      }),
      (c) => {
        const { at } = c.req.valid("query");
        return c.json(whereVisits(db, new Date(at)), 200);
      }
    )
    .openapi(
      createRoute({
        description:
          "Each stay, newest first, at most 200: every one, or those at the place the phone named " +
          "(`place`, matched in part), or by `latitude` and `longitude` within `radiusM` (100 m). " +
          "`from` and `to` bound it (a local day is the reader's to turn into them); the whole history without them.",
        method: "get",
        path: "/visits",
        request: {
          query: z
            .object({
              from: Instant.optional(),
              latitude: z.coerce.number().pipe(Latitude).optional(),
              longitude: z.coerce.number().pipe(Longitude).optional(),
              place: z.string().trim().min(1).max(200).optional(),
              radiusM: z.coerce.number().min(10).max(5000).optional(),
              to: Instant.optional(),
            })
            .refine(
              (q) =>
                (q.latitude === undefined) === (q.longitude === undefined) &&
                (q.place === undefined || q.latitude === undefined),
              { message: "give place, or latitude and longitude, or neither" }
            ),
        },
        responses: {
          200: json(z.array(Visit), "Visits"),
          404: json(ApiError, "No place the phone named matches"),
        },
      }),
      (c) => {
        const { from, latitude, longitude, place, radiusM, to } =
          c.req.valid("query");
        const circle =
          latitude === undefined || longitude === undefined
            ? undefined
            : { latitude, longitude, radiusM };
        const visits = visitsTo(db, place === undefined ? circle : { place }, {
          from: from === undefined ? undefined : new Date(from),
          to: to === undefined ? undefined : new Date(to),
        });
        return visits
          ? c.json(visits, 200)
          : c.json(
              {
                error: "not_found" as const,
                message: "no place the phone named matches",
              },
              404
            );
      }
    );
}
