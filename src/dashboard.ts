import { HEADERS, text } from "./http";
import { snapshot } from "./plate";
import { detail, runDetail } from "./plate-detail";

// The app's status reads (`/status/` on the local port, behind its key): the plate (`plate.ts`), a card's detail and a
// run (`plate-detail.ts`), as JSON for Life.app's native window and menu. Read-only: it changes nothing, sends nothing.

const json = (body: unknown) => Response.json(body, { headers: HEADERS });

/** A card's detail, or its next page: `before` must be an instant. */
async function card(id: string, url: URL) {
  const before = url.searchParams.get("before") ?? undefined;
  if (before && Number.isNaN(Date.parse(before))) {
    return text("before must be an instant", 400);
  }
  return json(await detail(id, before));
}

/** The reads behind `refusal` (`keyRefusal`: the local key the app holds). */
export function createDashboard(
  refusal: (req: Request) => Promise<Response | null>
) {
  async function owned(url: URL) {
    const { pathname } = url;
    if (pathname === "/status/snapshot") {
      return json(await snapshot());
    }
    if (pathname.startsWith("/status/card/")) {
      return card(pathname.slice("/status/card/".length), url);
    }
    if (pathname === "/status/run") {
      const run = await runDetail(url.searchParams.get("id") ?? "");
      return run ? json(run) : text("no such run", 404);
    }
    return null;
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!url.pathname.startsWith("/status/") || req.method !== "GET") {
      return null;
    }
    return (await refusal(req)) ?? owned(url);
  }

  return { handle };
}
