import { join } from "node:path";
import { FROZEN } from "./clock";
import { HEADERS, text } from "./http";
import { snapshot, strip } from "./plate";
import { detail, runDetail } from "./plate-detail";
import { connector } from "./settings";
import { isLocal, localKey, type SignIn } from "./signin";
import { ROOT } from "./truth";

// The status page (`/`, its files and reads under /status/): Life's architecture as a plate of live cards
// (`plate.ts`), read-only, behind the owner's sign-in (`signin.ts`). It changes nothing and sends nothing.

const LEADING_DOT = /^\.\//;
const ICON_DOT = /(<circle[^>]*fill=")[^"]*"/;
const APP = join(ROOT, "assets", "dashboard", "index.html");
/** How often an open page gets the plate again (only when something on it changed; a ping in between keeps it open). */
export const EVERY_MS = 3000;

/** The page and its files, bundled by Bun on first use (React and Motion, no build step), by published path. */
let bundle: Promise<Map<string, Blob>> | undefined;
const bundled = () => {
  bundle ??= Bun.build({
    define: { "process.env.NODE_ENV": '"production"' },
    entrypoints: [APP],
    minify: true,
    naming: "[name]-[hash].[ext]",
    publicPath: "/status/",
  }).then((b) => {
    if (!b.success) {
      bundle = undefined;
      throw new Error(b.logs.map(String).join("\n"));
    }
    // The page itself is served at /, under one name; its files under /status/ by their hashed names.
    return new Map(
      b.outputs.map((o) => [
        o.type.startsWith("text/html")
          ? "index.html"
          : o.path.replace(LEADING_DOT, ""),
        o,
      ])
    );
  });
  return bundle;
};

const json = (body: unknown) => Response.json(body, { headers: HEADERS });

/**
 * The plate as server-sent events: a snapshot whenever it changed, a ping otherwise, until the page closes. A write
 * after the page closed would throw where nothing catches it, in the watcher's own process: `open` guards every one,
 * and one read at a time (a cold plate takes seconds) so reads never pile up.
 */
function stream() {
  let timer: ReturnType<typeof setInterval> | undefined;
  let open = true;
  let reading = false;
  let last = "";
  const body = new ReadableStream<string>({
    cancel() {
      open = false;
      clearInterval(timer);
    },
    start(c) {
      const write = (chunk: string) => {
        if (open) {
          try {
            c.enqueue(chunk);
          } catch {
            open = false;
            clearInterval(timer);
          }
        }
      };
      const send = async () => {
        if (reading || !open) {
          return;
        }
        reading = true;
        try {
          const plate = await snapshot();
          // Changed is anything but the time it was read.
          const now = JSON.stringify({ ...plate, observedAt: null });
          write(
            now === last ? ": ping\n\n" : `data: ${JSON.stringify(plate)}\n\n`
          );
          last = now;
        } catch (e) {
          write(
            `event: failure\ndata: ${JSON.stringify((e as Error).message)}\n\n`
          );
        } finally {
          reading = false;
        }
      };
      // A first byte at once: the first plate can take longer than an idle connection is kept.
      write(": open\n\n");
      send();
      timer = setInterval(send, EVERY_MS);
    },
  });
  return new Response(body, {
    headers: {
      ...HEADERS,
      "content-type": "text/event-stream",
      "x-accel-buffering": "no",
    },
  });
}

// The tab's icon: Life's, its dot in the colour of the page's worst state (Ledger's status colours).
const TONES: Record<string, string> = {
  bad: "#c4382c",
  busy: "#2a62d8",
  idle: "#7d8186",
  ok: "#2f8f4e",
  teal: "#138f88",
  warn: "#b87212",
};
const ICON = Bun.file(join(ROOT, "assets", "icon", "icon.svg"));
const icon = async (tone: string) =>
  new Response(
    (await ICON.text()).replace(ICON_DOT, `$1${TONES[tone] ?? TONES.idle}"`),
    { headers: { ...HEADERS, "content-type": "image/svg+xml" } }
  );

/** Builds the page ahead of its first visit, so neither he nor the Worker's 8 s race waits for the bundle. */
export const warmPage = () => {
  bundled().catch((e: Error) => console.error(`status page: ${e.message}`));
};

/** How often the Mac sends the always-on Worker (worker/status.ts) the plate it shows while the Mac is away. */
export const PUSH_MS = 60_000;

/**
 * Sends the Worker the plate without his words (`strip`), and the page's files on the first push of a process (each
 * commit restarts it), so the Worker can show the page while the Mac is away. Off without LIFE_STATUS_PUSH_SECRET and
 * in a frozen run; a failed push only waits for the next.
 */
export function pushPlate() {
  const secret = process.env.LIFE_STATUS_PUSH_SECRET;
  if (!secret || FROZEN) {
    return;
  }
  let filesSent = false;
  const once = async () => {
    try {
      const files = filesSent
        ? undefined
        : Object.fromEntries(
            await Promise.all(
              [...(await bundled())].map(
                async ([name, f]) =>
                  [name, { text: await f.text(), type: f.type }] as const
              )
            )
          );
      const res = await fetch(`${connector().origin}/__status/push`, {
        body: JSON.stringify({ files, snapshot: strip(await snapshot()) }),
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(30_000),
      });
      filesSent ||= res.ok;
    } catch {
      // Offline, or the Worker away: the next push carries the plate as it is then.
    }
  };
  once();
  setInterval(once, PUSH_MS);
}

/** A card's detail, or its next page: `before` must be an instant. */
async function card(id: string, url: URL) {
  const before = url.searchParams.get("before") ?? undefined;
  if (before && Number.isNaN(Date.parse(before))) {
    return text("before must be an instant", 400);
  }
  return json(await detail(id, before));
}

/** The status page, for his sign-in (`signIn`, with the connector) or the local key the app holds (`isLocal`). */
export function createDashboard(signIn: SignIn | null) {
  localKey();
  /** Everything past sign-in. */
  async function owned(url: URL) {
    const { pathname } = url;
    if (pathname === "/") {
      const page = (await bundled()).get("index.html");
      return new Response(page, {
        headers: { ...HEADERS, "content-type": "text/html; charset=utf-8" },
      });
    }
    if (pathname === "/status/stream") {
      return stream();
    }
    if (pathname === "/status/snapshot") {
      return json(await snapshot());
    }
    if (pathname.startsWith("/status/card/")) {
      return card(pathname.slice("/status/card/".length), url);
    }
    if (pathname === "/status/icon.svg") {
      return icon(url.searchParams.get("tone") ?? "idle");
    }
    if (pathname === "/status/run") {
      const run = await runDetail(url.searchParams.get("id") ?? "");
      return run ? json(run) : text("no such run", 404);
    }
    const file = (await bundled()).get(pathname.slice("/status/".length));
    return file
      ? new Response(file, {
          headers: { ...HEADERS, "content-type": file.type },
        })
      : null;
  }

  async function handle(req: Request): Promise<Response | null> {
    const url = new URL(req.url);
    if (
      !(url.pathname === "/" || url.pathname.startsWith("/status/")) ||
      req.method !== "GET"
    ) {
      return null;
    }
    if (isLocal(req)) {
      return owned(url);
    }
    const refused = signIn
      ? await signIn.refusal(req, url.pathname === "/" ? "/" : undefined)
      : text("local only", 401);
    return refused ?? owned(url);
  }

  return { handle };
}
