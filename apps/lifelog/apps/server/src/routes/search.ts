// Search: passages ranked by meaning and by the words typed.
import { createRoute, z } from "@hono/zod-openapi";
import type { Services } from "../services";
import { ApiError, json, router } from "./common";

const SearchRequest = z
  .object({
    dateRange: z
      .object({
        from: z.iso.datetime().optional(),
        to: z.iso.datetime().optional(),
      })
      .optional()
      .describe(
        "Capture time of the passage's start: from inclusive, to exclusive."
      ),
    limit: z.int().min(1).max(50).default(20),
    people: z
      .array(z.uuid())
      .max(50)
      .optional()
      .describe("Person ids: passages where one of them speaks."),
    query: z.string().trim().min(3).max(500),
  })
  .openapi("SearchRequest");

const SearchHit = z
  .object({
    capturedFrom: z.iso.datetime().nullable(),
    capturedTo: z.iso.datetime().nullable(),
    conversationId: z.uuid(),
    exact: z.boolean().describe("The passage contains the query as typed."),
    firstTurn: z.int(),
    jobId: z.uuid(),
    languageCode: z.string(),
    lastTurn: z.int(),
    passageId: z.uuid(),
    score: z.number(),
    speakers: z.array(z.string()).describe("People the owner named."),
    text: z.string().describe('"Name: words" lines; unnamed speakers bare.'),
  })
  .openapi("SearchHit");

export function searchRoutes({ search }: Pick<Services, "search">) {
  return router().openapi(
    createRoute({
      description:
        "Passages (about 30 to 60 s of turns) ranked by meaning and by the passages holding " +
        "every word typed, the two rankings fused, best first: a passage both find outranks " +
        "one only one finds; by words alone while the embedder is down. Embedded on the Mac " +
        "(docs/providers.md). Conversations are " +
        "indexed in the background after each change.",
      method: "post",
      path: "/search",
      request: {
        body: {
          content: { "application/json": { schema: SearchRequest } },
          required: true,
        },
      },
      responses: {
        200: json(z.object({ hits: z.array(SearchHit) }), "Best first"),
        503: json(ApiError, "Search is off on this server"),
      },
    }),
    async (c) => {
      const { dateRange, limit, people, query } = c.req.valid("json");
      const hits = await search?.query({
        from: dateRange?.from ? new Date(dateRange.from) : undefined,
        limit,
        people,
        text: query,
        to: dateRange?.to ? new Date(dateRange.to) : undefined,
      });
      if (!hits) {
        return c.json(
          {
            error: "search_unavailable" as const,
            message: "search is off on this server",
          },
          503
        );
      }
      return c.json({ hits }, 200);
    }
  );
}
