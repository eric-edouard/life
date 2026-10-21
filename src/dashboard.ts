import { join } from "node:path";
import { HEADERS, text } from "./http";
import { detail, runDetail, snapshot } from "./plate";
import type { SignIn } from "./signin";
import { ROOT } from "./truth";

// The status page (`/`, its files and reads under /status/): Life's architecture as a plate of live cards
// (`plate.ts`), read-only, behind the owner's sign-in (`signin.ts`). It changes nothing and sends nothing.

const APP = join(ROOT, "assets", "dashboard", "index.html");
/** How often an open page gets the plate again (only when something on it changed; a ping in between keeps it open). */
export const EVERY_MS = 3000;

/** The page and its files, bundled by Bun on first use (React and Motion, no build step), by published path. */
let bundle: Promise<Map<string, Blob>> | undefined;
const files = () => {
  bundle ??= Bun.build({
    entrypoints: [APP],
    minify: true,
    naming: "[name]-[hash].[ext]",
    publicPath: "/status/",
  }).then((b) => {
    if (!b.success) {
      bundle = undefined;
      throw new Error(b.logs.map(String).join("\n"));
    }
    return new Map(b.outputs.map((o) => [o.path.replace(/^\.\//, ""), o]));
  });
  return bundle;
};

const json = (body: unknown) => Response.json(body, { headers: HEADERS });

/** The plate as server-sent events: a snapshot whenever it changed, a ping otherwise, until the page closes. */
function stream() {
  let timer: ReturnType<typeof setInterval> | undefined;
  let last = "";
  const body = new ReadableStream<string>({
    cancel() {
      clearInterval(timer);
    },
    start(c) {
      const send = async () => {
        try {
          const now = JSON.stringify(await snapshot());
          c.enqueue(now === last ? ": ping\n\n" : `data: ${now}\n\n`);
          last = now;
        } catch (e) {
          c.enqueue(`event: failure\ndata: ${JSON.stringify((e as Error).message)}\n\n`);
        }
      };
      send();
      timer = setInterval(send, EVERY_MS);
    },
  });
  return new Response(body, {
    headers: { ...HEADERS, "content-type": "text/event-stream", "x-accel-buffering": "no" },
  });
}

export function createDashboard(signIn: SignIn) {
  /** Everything past sign-in. */
  async function owned(url: URL) {
    const { pathname } = url;
    if (pathname === "/") {
      const page = (await files()).get("index.html");
      return new Response(page, { headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/status/stream") {
      return stream();
    }
    if (pathname === "/status/snapshot") {
      return json(await snapshot());
    }
    if (pathname.startsWith("/status/card/")) {
      const id = pathname.slice("/status/card/".length);
      return json(await detail(id, url.searchParams.get("before") ?? undefined));
    }
    if (pathname === "/status/run") {
      const run = await runDetail(url.searchParams.get("id") ?? "");
      return run ? json(run) : text("no such run", 404);
    }
    const file = (await files()).get(pathname.slice("/status/".length));
    return file ? new Response(file, { headers: { ...HEADERS, "content-type": file.type } }) : null;
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (!(url.pathname === "/" || url.pathname.startsWith("/status/")) || req.method !== "GET") {
      return null;
    }
    const refused = await signIn.refusal(req, url.pathname === "/" ? "/" : undefined);
    return refused ?? owned(url);
  }

  return { handle };
}
