import { createRemoteJWKSet, jwtVerify } from "jose";

// The status page's always-on edge (Cloudflare Worker, routes in wrangler.jsonc): every request goes to the Mac as
// before; only when the Mac can't be reached does the Worker answer itself, behind the same owner check as the Mac,
// with the page and the last plate the Mac pushed: metadata only (src/plate.ts `strip`), never his words. It also
// takes those pushes (POST /__status/push, a shared secret). It decides nothing else.

interface Env {
  /** LIFE_OWNER_SUB, as the Mac checks it. */
  OWNER_SUB: string;
  /** LIFE_STATUS_PUSH_SECRET, the Mac's. */
  PUSH_SECRET: string;
  STATUS: KVNamespace;
}

const ISSUER = "https://lifelog.ericedouard.com/api/auth";
const RESOURCE = "https://life.ericedouard.com/mcp";
/** The session cookie the Mac sets (`src/signin.ts`). */
const SESSION = "__Host-life=";
const COOKIES = /;\s*/;
/** How long the Mac gets to answer before the Worker answers for it (the stream's own data can take longer). */
const WAIT_MS = 8000;
const HEADERS = {
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; frame-ancestors 'none'",
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
};
const jwks = createRemoteJWKSet(new URL(`${ISSUER}/jwks`));

/** The Mac is out of reach: no answer in time, or Cloudflare's own answer that it has no tunnel or origin. */
const unreachable = (r: Response | null) =>
  !r || r.status === 502 || r.status === 504 || r.status >= 520;

async function isOwner(req: Request, env: Env) {
  const token = (req.headers.get("cookie") ?? "")
    .split(COOKIES)
    .find((c) => c.startsWith(SESSION))
    ?.slice(SESSION.length);
  if (!token) {
    return false;
  }
  try {
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["EdDSA"],
      audience: RESOURCE,
      issuer: ISSUER,
    });
    return (
      payload.sub === env.OWNER_SUB &&
      String(payload.scope ?? "")
        .split(" ")
        .includes("life:read")
    );
  } catch {
    return false;
  }
}

const page = (body: string, status: number) =>
  new Response(body, {
    headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
    status,
  });

/** The Mac's push: the plate (metadata only) and, when they changed, the page's files. */
async function push(req: Request, env: Env) {
  if (req.headers.get("authorization") !== `Bearer ${env.PUSH_SECRET}`) {
    return page("no", 401);
  }
  const body = (await req.json()) as {
    files?: Record<string, { text: string; type: string }>;
    snapshot: unknown;
  };
  const pushedAt = new Date().toISOString();
  await env.STATUS.put("snapshot", JSON.stringify(body.snapshot), {
    metadata: { pushedAt },
  });
  await Promise.all(
    Object.entries(body.files ?? {}).map(([name, f]) =>
      env.STATUS.put(`file:${name}`, f.text, { metadata: { type: f.type } })
    )
  );
  return new Response(null, { status: 204 });
}

/** The Mac is away: the page and its last plate, for the owner only. */
async function offline(req: Request, env: Env, path: string) {
  if (!(await isOwner(req, env))) {
    return page("Life's Mac is offline. Sign in once it is back.", 503);
  }
  if (path === "/status/stream") {
    return page("the Mac is offline", 503);
  }
  if (path === "/status/snapshot") {
    const { metadata, value } = await env.STATUS.getWithMetadata<{
      pushedAt: string;
    }>("snapshot");
    return value
      ? new Response(value, {
          headers: {
            ...HEADERS,
            "content-type": "application/json",
            "x-life-pushed-at": metadata?.pushedAt ?? "",
          },
        })
      : page("nothing pushed yet", 503);
  }
  const name = path === "/" ? "index.html" : path.slice("/status/".length);
  const { metadata, value } = await env.STATUS.getWithMetadata<{
    type: string;
  }>(`file:${name}`);
  return value
    ? new Response(value, {
        headers: { ...HEADERS, "content-type": metadata?.type ?? "text/plain" },
      })
    : page("not found", 404);
}

export default {
  async fetch(req: Request, env: Env) {
    const { pathname } = new URL(req.url);
    if (pathname === "/__status/push" && req.method === "POST") {
      return push(req, env);
    }
    const mac = await Promise.race([
      fetch(req).catch(() => null),
      new Promise<null>((done) => setTimeout(() => done(null), WAIT_MS)),
    ]);
    return mac && !unreachable(mac) ? mac : offline(req, env, pathname);
  },
} satisfies ExportedHandler<Env>;
