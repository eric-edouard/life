import { createRemoteJWKSet } from "jose";
import { ownerTokens } from "../src/auth";
import { HEADERS, SESSION } from "../src/http";

// Life's public edge (Cloudflare Worker on every path of life.ericedouard.com, wrangler.jsonc): every request goes to
// the Mac through Tailscale Funnel (`MAC_ORIGIN`, HTTPS 443-class ports any network and VPN lets through, unlike the
// Cloudflare tunnel's 7844). For the status page only, when the Mac can't be reached, the Worker answers itself,
// behind the same owner check as the Mac, with the page and the last plate the Mac pushed: metadata only
// (src/plate.ts `strip`), never his words. It also takes those pushes (POST /__status/push, a shared secret). It
// decides nothing else.

interface Env {
  /** The `connector` setting's issuer, as the Mac checks it (a secret, like OWNER_SUB). */
  ISSUER: string;
  /** The Mac's Funnel origin (`tailscale funnel --https=8443 http://127.0.0.1:46200`), set in wrangler.jsonc. */
  MAC_ORIGIN: string;
  /** The `connector` setting's owner, as the Mac checks it. */
  OWNER_SUB: string;
  /** LIFE_STATUS_PUSH_SECRET, the Mac's. */
  PUSH_SECRET: string;
  STATUS: KVNamespace;
}

const COOKIES = /;\s*/;
/** How long the Mac gets to answer before the Worker answers for it (the stream's own data can take longer). */
const WAIT_MS = 8000;
/** The issuer's keys, fetched on the first sign-in check (the issuer is only known from `env` then). */
let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

/** The Mac is out of reach: no answer in time, or Cloudflare's own answer that it has no tunnel or origin. */
const unreachable = (r: Response | null) =>
  !r || r.status === 502 || r.status === 504 || r.status >= 520;

/** The Mac's own check (`ownerTokens`) on the session cookie the Mac set. */
async function isOwner(req: Request, env: Env) {
  const token = (req.headers.get("cookie") ?? "")
    .split(COOKIES)
    .find((c) => c.startsWith(`${SESSION}=`))
    ?.slice(SESSION.length + 1);
  if (!token) {
    return false;
  }
  jwks ??= createRemoteJWKSet(new URL(`${env.ISSUER}/jwks`));
  const whose = await ownerTokens({
    issuer: env.ISSUER,
    jwks,
    ownerSub: env.OWNER_SUB,
    // The Worker serves the connector's own origin, so its resource is that origin's /mcp.
    resource: `${new URL(req.url).origin}/mcp`,
  })(token);
  return !("refusal" in whose);
}

/** The Mac's push secret, compared in constant time; no secret set, no push. */
function pushAllowed(req: Request, env: Env) {
  if (!env.PUSH_SECRET) {
    return false;
  }
  const enc = new TextEncoder();
  const got = enc.encode(req.headers.get("authorization") ?? "");
  const want = enc.encode(`Bearer ${env.PUSH_SECRET}`);
  return (
    got.byteLength === want.byteLength &&
    crypto.subtle.timingSafeEqual(got, want)
  );
}

const page = (body: string, status: number) =>
  new Response(body, {
    headers: { ...HEADERS, "content-type": "text/plain; charset=utf-8" },
    status,
  });

/** The Mac's push: the plate (metadata only) and, when they changed, the page's files. */
async function push(req: Request, env: Env) {
  if (!pushAllowed(req, env)) {
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
    const { search } = new URL(req.url);
    // The Mac answers as is: its redirects (sign-in) go back to the browser, not followed here.
    const toMac = () =>
      fetch(new Request(`${env.MAC_ORIGIN}${pathname}${search}`, req), {
        redirect: "manual",
      });
    if (!(pathname === "/" || pathname.startsWith("/status/"))) {
      return toMac();
    }
    const mac = await Promise.race([
      toMac().catch(() => null),
      new Promise<null>((done) => setTimeout(() => done(null), WAIT_MS)),
    ]);
    return mac && !unreachable(mac) ? mac : offline(req, env, pathname);
  },
} satisfies ExportedHandler<Env>;
