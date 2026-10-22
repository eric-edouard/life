import { Hono } from "hono";
import { HEADERS, text } from "./http";
import { snapshot } from "./plate";
import { detail, runDetail } from "./plate-detail";

// The app's status reads (`/status/` on the local port, behind its key): the plate (`plate.ts`), a card's detail and a
// run (`plate-detail.ts`), as JSON for Life.app's native window and menu. Read-only: it changes nothing, sends nothing.

const json = (body: unknown) => Response.json(body, { headers: HEADERS });

const CARD = "/status/card/";

/** The reads behind `refusal` (`keyRefusal`: the local key the app holds). */
export function createDashboard(
  refusal: (req: Request) => Promise<Response | null>
) {
  return (
    new Hono()
      .get("/status/*", async (c, next) => {
        const refused = await refusal(c.req.raw);
        if (refused) {
          return refused;
        }
        await next();
      })
      .get("/status/snapshot", async () => json(await snapshot()))
      // A card's detail, or its next page: `before` must be an instant.
      .get(`${CARD}*`, async (c) => {
        const before = c.req.query("before");
        if (before && Number.isNaN(Date.parse(before))) {
          return text("before must be an instant", 400);
        }
        const id = new URL(c.req.url).pathname.slice(CARD.length);
        return json(await detail(id, before));
      })
      .get("/status/run", async (c) => {
        const run = await runDetail(c.req.query("id") ?? "");
        return run ? json(run) : text("no such run", 404);
      })
  );
}
